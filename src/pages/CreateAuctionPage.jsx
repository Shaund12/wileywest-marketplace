import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { canPerformAuctionAction } from '../utils/featureFlags';
import { getSupportedTokens, formatTokenAmount } from '../utils/tokenRegistry';
import { fetchTokenPriceInUSDC } from '../utils/tokenUtils';
import './AuctionStyles.css';
import './SellPage.css';

/* =========================================================
   IPFS/IPNS/Arweave + SmartMedia (self-contained utilities)
   ========================================================= */
const IPFS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipfs/',
    'https://cf-ipfs.com/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://infura-ipfs.io/ipfs/',
    'https://w3s.link/ipfs/',
    'https://nftstorage.link/ipfs/',
    'https://ipfs.io/ipfs/',
];

const IPNS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipns/',
    'https://cf-ipfs.com/ipns/',
    'https://dweb.link/ipns/',
    'https://gateway.pinata.cloud/ipns/',
    'https://infura-ipfs.io/ipns/',
    'https://w3s.link/ipns/',
    'https://nftstorage.link/ipns/',
    'https://ipfs.io/ipns/',
];

const isString = (v) => typeof v === 'string' && v.trim().length > 0;
const uniq = (arr) => Array.from(new Set(arr));
const flatten = (arrs) => arrs.reduce((a, b) => a.concat(b), []);
const isVideoUrl = (u) => isString(u) && /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(u);

function erc1155HexId(tokenId) {
    try {
        return BigInt(tokenId).toString(16).toLowerCase().padStart(64, '0');
    } catch {
        return String(tokenId).replace(/^0x/i, '').toLowerCase().padStart(64, '0');
    }
}

function expandToCandidateUrls(raw) {
    if (!isString(raw)) return [];
    const url = raw.trim();
    if (url.startsWith('data:')) return [url];

    // Arweave
    if (url.startsWith('ar://')) return [`https://arweave.net/${url.slice(5)}`];
    if (/^https?:\/\/arweave\.net\//i.test(url)) return [url];

    // ipfs://CID/... → try multiple gateways
    if (url.startsWith('ipfs://')) {
        const rest = url.slice(7).replace(/^ipfs\//i, '');
        return IPFS_GATEWAYS.map((g) => g + rest);
    }
    // ipns://name → try multiple gateways
    if (url.startsWith('ipns://')) {
        const rest = url.slice(7).replace(/^ipns\//i, '');
        return IPNS_GATEWAYS.map((g) => g + rest);
    }

    // http(s) with /ipfs/ or /ipns/
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const ipfsIdx = parts.indexOf('ipfs');
        const ipnsIdx = parts.indexOf('ipns');
        if (ipfsIdx !== -1 && parts[ipfsIdx + 1]) {
            const rest = parts.slice(ipfsIdx + 1).join('/');
            return IPFS_GATEWAYS.map((g) => g + rest);
        }
        if (ipnsIdx !== -1 && parts[ipnsIdx + 1]) {
            const rest = parts.slice(ipnsIdx + 1).join('/');
            return IPNS_GATEWAYS.map((g) => g + rest);
        }
        return [url];
    } catch {
        // bare CID
        if (/^[a-z0-9]+$/i.test(url)) return IPFS_GATEWAYS.map((g) => g + url);
        return [url];
    }
}

function metadataCandidatesFromUri(uri, tokenId, is1155 = false) {
    if (!isString(uri)) return [];
    const base = expandToCandidateUrls(uri);
    if (is1155 && uri.includes('{id}')) {
        const id64 = erc1155HexId(tokenId);
        return base.map((u) => u.replace('{id}', id64));
    }
    return base;
}

async function fetchJsonFromCandidates(candidates, timeoutMs = 9000) {
    for (const url of candidates) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), timeoutMs);
            const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
            clearTimeout(t);
            if (!res.ok) continue;

            // Some gateways lie on content-type; be tolerant
            const text = await res.text();
            try {
                const json = JSON.parse(text);
                return { json, usedUrl: url };
            } catch {
                // not json, try next
            }
        } catch {
            // try next
        }
    }
    throw new Error('No working metadata URL found');
}

function findFirstWorkingImage(candidates, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        if (!candidates?.length) return reject(new Error('No candidates'));
        if (typeof window === 'undefined') return reject(new Error('No window'));

        let i = 0;
        const tryNext = () => {
            if (i >= candidates.length) return reject(new Error('No working image'));
            const test = candidates[i++];
            const img = new Image();
            const timer = setTimeout(() => {
                img.onload = img.onerror = null;
                tryNext();
            }, timeoutMs);
            img.onload = () => {
                clearTimeout(timer);
                resolve(test);
            };
            img.onerror = () => {
                clearTimeout(timer);
                tryNext();
            };
            img.src = test + (test.includes('?') ? '&' : '?') + 'cb=' + Date.now();
        };
        tryNext();
    });
}

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

function svgFallbackDataUrl({ seed = 'media', width = 640, height = 460, title = 'NFT Preview' }) {
    const h = hashString(seed);
    const hue = h % 360;
    const hue2 = (hue + 180) % 360;
    const gid = `g${(h % 1e9).toString(36)}`;
    const blobs = (h % 7) + 3;
    const label = (title || '').slice(0, 28) || 'NFT Preview';
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},70%,18%)"/>
      <stop offset="100%" stop-color="hsl(${hue2},70%,16%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#${gid})"/>
  ${Array.from({ length: blobs }).map((_, i) => {
        const a = (h + i * 97) % 360;
        const r = 18 + ((h >> i) % 42);
        const cx = (width / (blobs + 1)) * (i + 1);
        const cy = (height / (blobs + 1)) * ((i % 3) + 1);
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsla(${a},70%,60%,0.25)"/>`;
    }).join('')}
  <text x="50%" y="${height - 18}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" font-size="16" fill="rgba(255,255,255,0.9)" text-anchor="middle">${label}</text>
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const smartUrlCache = new Map();
/** SmartMedia: pick working video (mp4/webm/…) or image; otherwise nice SVG fallback */
function SmartMedia({ srcList = [], alt = '', width = 640, height = 460, seed = 'media', title = '', className = '' }) {
    const [finalUrl, setFinalUrl] = useState(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const raws = srcList.filter(isString);
        const key = raws.join('|');
        if (!raws.length) {
            setFinalUrl(null);
            setFailed(true);
            return;
        }

        if (smartUrlCache.has(key)) {
            setFinalUrl(smartUrlCache.get(key));
            setFailed(false);
            return;
        }

        const candidates = uniq(flatten(raws.map(expandToCandidateUrls)));
        // Prefer video if the URL clearly indicates one
        const videoCandidate = candidates.find(isVideoUrl);
        if (videoCandidate) {
            smartUrlCache.set(key, videoCandidate);
            if (!cancelled) {
                setFinalUrl(videoCandidate);
                setFailed(false);
            }
            return;
        }

        findFirstWorkingImage(candidates)
            .then((u) => {
                if (cancelled) return;
                smartUrlCache.set(key, u);
                setFinalUrl(u);
                setFailed(false);
            })
            .catch(() => {
                if (!cancelled) {
                    setFinalUrl(null);
                    setFailed(true);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [JSON.stringify(srcList)]);

    const fallback = svgFallbackDataUrl({ seed, width, height, title });
    const url = failed || !finalUrl ? fallback : finalUrl;

    if (isVideoUrl(url)) {
        return (
            <video
                src={url}
                controls
                className={className}
                width={width}
                height={height}
                style={{ display: 'block', borderRadius: 12, background: '#111', maxWidth: '100%', objectFit: 'cover' }}
            />
        );
    }
    return (
        <img
            src={url}
            alt={alt}
            className={className}
            width={width}
            height={height}
            loading="lazy"
            onError={() => setFailed(true)}
            style={{ display: 'block', borderRadius: 12, maxWidth: '100%', objectFit: 'cover' }}
        />
    );
}

/* =========================================================
   ABIs and Token Config
   ========================================================= */
const ERC721_ABI = [
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
];

const ERC1155_ABI = [
    'function uri(uint256 id) view returns (string)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
];

const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
];

// Token addresses (Vitruveo chain)
const WVTRU_ADDRESS = '0x3ccc3F22462cAe34766820894D04a40381201ef9';
const USDC_ADDRESS = '0xbCfB3FCa16b12C7756CD6C24f1cC0AC0E38569CF';

function CreateAuctionPage() {
    const navigate = useNavigate();
    const { wallet, connect, provider, signer } = useWallet();
    const { status, setStatus, marketplaceAddress } = useMarketplace();
    const [searchParams] = useSearchParams();

    const [formData, setFormData] = useState({
        nftContract: searchParams.get('contract') || '',
        tokenId: searchParams.get('tokenId') || '',
        quantity: '1',
        reservePrice: '',
        startPrice: '',
        duration: '24', // hours
        paymentToken: ethers.ZeroAddress,
        minBidIncrementBps: '500', // 5%
        antiSnipeSeconds: '600', // 10 minutes
    });

    const [metadata, setMetadata] = useState(null);
    const [nftImage, setNftImage] = useState('');
    const [nftName, setNftName] = useState('');
    const [nftType, setNftType] = useState(null);
    const [balance, setBalance] = useState('0');
    const [loading, setLoading] = useState(false);
    const [ownershipVerified, setOwnershipVerified] = useState(false);
    const [auctionSuccess, setAuctionSuccess] = useState(false);

    // Set document title
    useEffect(() => {
        document.title = 'Create Auction • BlockDust';
    }, []);

    useEffect(() => {
        if (!wallet) {
            // Redirect to homepage if not connected
            navigate('/?connect=true');
            return;
        }

        if (!canPerformAuctionAction(wallet, 'create')) {
            // Show error if wallet not allowed
            navigate('/marketplace');
            return;
        }
    }, [wallet, navigate]);

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: value
        }));
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        
        if (!wallet) {
            await connect();
            return;
        }

        if (!ownershipVerified) {
            setStatus('Error: Ownership not verified. You must own this NFT to create an auction.');
            return;
        }

        try {
            // TODO: Implement auction creation logic
            setStatus('Creating auction...');
            console.log('Creating auction with data:', formData);
            
            // Show success animation
            setAuctionSuccess(true);
            
            // Reset success state after animation completes
            setTimeout(() => {
                setAuctionSuccess(false);
                navigate('/auctions/my');
            }, 3000);
            
        } catch (error) {
            setStatus(`Error: ${error.message || 'Could not create auction'}`);
        }
    };

    /* =========================
       NFT metadata (robust)
       ========================= */
    function mediaCandidatesFromMetadata(m) {
        if (!m || typeof m !== 'object') return [];
        return [m.image, m.image_url, m.imageUrl, m.animation_url, m.animationUrl].filter(isString);
    }

    const fetchNftMetadata = async () => {
        if (!formData.nftContract || !formData.tokenId) {
            setStatus('Please enter contract address and token ID');
            return;
        }
        if (!wallet) {
            setStatus('Please connect your wallet first');
            return;
        }
        if (!provider) {
            setStatus('No provider available. Please reconnect your wallet.');
            return;
        }

        setLoading(true);
        setStatus('Fetching NFT metadata...');
        setMetadata(null);
        setNftImage('');
        setNftName('');
        setOwnershipVerified(false);

        try {
            if (!ethers.isAddress(formData.nftContract)) throw new Error('Invalid contract address format');
            const checksum = ethers.getAddress(formData.nftContract);

            // Try ERC721 first
            try {
                const erc721 = new ethers.Contract(checksum, ERC721_ABI, provider);

                const owner = await erc721.ownerOf(formData.tokenId);
                const isOwner = owner?.toLowerCase?.() === wallet?.toLowerCase?.();
                setOwnershipVerified(!!isOwner);
                if (!isOwner) {
                    setStatus('Warning: You are not the owner of this NFT');
                    setLoading(false);
                    return;
                }

                const tokenURI = await erc721.tokenURI(formData.tokenId);
                const metaCands = metadataCandidatesFromUri(tokenURI, formData.tokenId, false);
                const { json } = await fetchJsonFromCandidates(metaCands);

                setMetadata(json);
                setNftName(json?.name || `NFT #${formData.tokenId}`);

                // Pre-resolve one working preview URL for zoom
                try {
                    const media = uniq(flatten(mediaCandidatesFromMetadata(json).map(expandToCandidateUrls)));
                    const firstVideo = media.find(isVideoUrl);
                    if (firstVideo) setNftImage(firstVideo);
                    else setNftImage(await findFirstWorkingImage(media));
                } catch {
                    setNftImage('');
                }

                setNftType('ERC721');
                setBalance('1');
                setStatus('');
                return;
            } catch {
                // fallthrough to ERC1155
            }

            // Try ERC1155
            try {
                const erc1155 = new ethers.Contract(checksum, ERC1155_ABI, provider);

                const bal = await erc1155.balanceOf(wallet, formData.tokenId);
                const ownerBalance = bal.toString();
                setBalance(ownerBalance);
                if (ownerBalance === '0') {
                    setStatus('Warning: You do not own any of these tokens');
                    setLoading(false);
                    return;
                }
                setOwnershipVerified(true);

                const uri = await erc1155.uri(formData.tokenId);
                const metaCands = metadataCandidatesFromUri(uri, formData.tokenId, true);
                const { json } = await fetchJsonFromCandidates(metaCands);

                setMetadata(json);
                setNftName(json?.name || `NFT #${formData.tokenId}`);

                try {
                    const media = uniq(flatten(mediaCandidatesFromMetadata(json).map(expandToCandidateUrls)));
                    const firstVideo = media.find(isVideoUrl);
                    if (firstVideo) setNftImage(firstVideo);
                    else setNftImage(await findFirstWorkingImage(media));
                } catch {
                    setNftImage('');
                }

                setNftType('ERC1155');
                setFormData((prev) => ({ ...prev, quantity: ownerBalance }));
                setStatus('');
            } catch {
                setStatus('Could not fetch NFT metadata. Make sure the contract and token ID are correct.');
            }
        } catch (error) {
            setStatus('Error fetching NFT metadata: ' + (error.message || error));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (formData.nftContract && formData.tokenId && wallet && provider) {
            fetchNftMetadata();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formData.nftContract, formData.tokenId, wallet, provider]);

    /* =========================
       Rarity helpers
       ========================= */
    const getTraitRarity = (trait) => {
        const map = {
            common: { label: 'Common', color: '#78909c', percentage: '25.4%' },
            uncommon: { label: 'Uncommon', color: '#26a69a', percentage: '15.2%' },
            rare: { label: 'Rare', color: '#5c6bc0', percentage: '8.7%' },
            epic: { label: 'Epic', color: '#ab47bc', percentage: '3.2%' },
            legendary: { label: 'Legendary', color: '#ffb300', percentage: '0.9%' },
        };
        const keys = Object.keys(map);
        const i = Math.floor((((trait.trait_type?.length) || 0) + (String(trait.value || '').length)) % 5);
        return map[keys[i]];
    };

    if (!wallet) {
        return (
            <div className="hp" style={{ maxWidth: 800, margin: '3rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head">
                    <h2>Create Auction</h2>
                    <p>Connect your wallet to create an auction</p>
                </div>
                <button onClick={connect} className="hp-btn hp-btn--primary">
                    Connect Wallet
                </button>
            </div>
        );
    }

    if (!canPerformAuctionAction(wallet, 'create')) {
        return (
            <div className="hp" style={{ maxWidth: 800, margin: '3rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head">
                    <h2>Access Restricted</h2>
                    <p>Your wallet is not currently allowed to create auctions during the beta period.</p>
                </div>
                <button onClick={() => navigate('/marketplace')} className="hp-btn">
                    Back to Marketplace
                </button>
            </div>
        );
    }

    return (
        <div className="hp" style={{ maxWidth: 800, margin: '3rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>Create Auction</h2>
                <p>Set up a timed auction for your NFT</p>
            </div>

            {/* NFT Preview */}
            {metadata && (
                <div className="nft-preview" style={{ marginBottom: '2rem', background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '12px' }}>
                    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                        <div style={{ minWidth: '200px' }}>
                            <SmartMedia
                                srcList={[
                                    nftImage,
                                    metadata?.image,
                                    metadata?.image_url,
                                    metadata?.imageUrl,
                                    metadata?.animation_url,
                                    metadata?.animationUrl,
                                ]}
                                alt={nftName}
                                width={200}
                                height={200}
                                seed={`${String(formData.nftContract)}-${String(formData.tokenId)}`}
                                title={nftName}
                            />
                        </div>
                        <div style={{ flex: 1 }}>
                            <h3>{nftName}</h3>
                            <p>{metadata?.description || 'No description available'}</p>
                            
                            {Array.isArray(metadata?.attributes) && metadata.attributes.length > 0 && (
                                <div style={{ marginTop: '1rem' }}>
                                    <h4>Properties</h4>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.5rem' }}>
                                        {metadata.attributes.slice(0, 6).map((attr, index) => {
                                            const rarity = getTraitRarity(attr);
                                            return (
                                                <div key={index} style={{ 
                                                    padding: '0.5rem', 
                                                    background: 'var(--bg-tertiary)', 
                                                    borderRadius: '6px',
                                                    border: `1px solid ${rarity.color}`
                                                }}>
                                                    <div style={{ fontSize: '0.75rem', color: rarity.color, fontWeight: 600 }}>
                                                        {attr.trait_type || 'Property'}
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                                                        {attr.value?.toString() || 'Unknown'}
                                                    </div>
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                        {rarity.label} ({rarity.percentage})
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            <form onSubmit={handleSubmit} className="create-auction-form">
                <div className="form-group">
                    <label htmlFor="nftContract">NFT Contract Address</label>
                    <input
                        type="text"
                        id="nftContract"
                        name="nftContract"
                        value={formData.nftContract}
                        onChange={handleChange}
                        placeholder="0x..."
                        required
                    />
                </div>

                <div className="form-group">
                    <label htmlFor="tokenId">Token ID</label>
                    <input
                        type="text"
                        id="tokenId"
                        name="tokenId"
                        value={formData.tokenId}
                        onChange={handleChange}
                        placeholder="1"
                        required
                    />
                </div>

                {!metadata && !loading && (
                    <button type="button" onClick={fetchNftMetadata} className="hp-btn" style={{ marginBottom: '1rem' }}>
                        Fetch NFT Data
                    </button>
                )}

                {loading && (
                    <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                        Loading NFT metadata...
                    </div>
                )}

                {nftType && (
                    <>
                        <div className="form-group">
                            <label htmlFor="quantity">Quantity (for ERC1155)</label>
                            <input
                                type="number"
                                id="quantity"
                                name="quantity"
                                min="1"
                                max={balance}
                                value={formData.quantity}
                                onChange={handleChange}
                                required
                            />
                            <small>Available: {balance}</small>
                        </div>

                        <div className="form-group">
                            <label htmlFor="paymentToken">Payment Token</label>
                            <select
                                id="paymentToken"
                                name="paymentToken"
                                value={formData.paymentToken}
                                onChange={handleChange}
                                required
                            >
                                {getSupportedTokens().map(token => (
                                    <option key={token.address} value={token.address}>
                                        {token.symbol} - {token.name}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="form-row">
                            <div className="form-group">
                                <label htmlFor="startPrice">Starting Price</label>
                                <input
                                    type="text"
                                    id="startPrice"
                                    name="startPrice"
                                    value={formData.startPrice}
                                    onChange={handleChange}
                                    placeholder="0.1"
                                    required
                                />
                            </div>

                            <div className="form-group">
                                <label htmlFor="reservePrice">Reserve Price</label>
                                <input
                                    type="text"
                                    id="reservePrice"
                                    name="reservePrice"
                                    value={formData.reservePrice}
                                    onChange={handleChange}
                                    placeholder="1.0"
                                    required
                                />
                            </div>
                        </div>

                        <div className="form-row">
                            <div className="form-group">
                                <label htmlFor="duration">Duration (hours)</label>
                                <select
                                    id="duration"
                                    name="duration"
                                    value={formData.duration}
                                    onChange={handleChange}
                                    required
                                >
                                    <option value="1">1 hour</option>
                                    <option value="6">6 hours</option>
                                    <option value="12">12 hours</option>
                                    <option value="24">24 hours</option>
                                    <option value="48">48 hours</option>
                                    <option value="168">7 days</option>
                                </select>
                            </div>

                            <div className="form-group">
                                <label htmlFor="minBidIncrementBps">Min Bid Increment (%)</label>
                                <select
                                    id="minBidIncrementBps"
                                    name="minBidIncrementBps"
                                    value={formData.minBidIncrementBps}
                                    onChange={handleChange}
                                    required
                                >
                                    <option value="100">1%</option>
                                    <option value="250">2.5%</option>
                                    <option value="500">5%</option>
                                    <option value="1000">10%</option>
                                </select>
                            </div>
                        </div>

                        <div className="form-group">
                            <label htmlFor="antiSnipeSeconds">Anti-Snipe Extension (minutes)</label>
                            <select
                                id="antiSnipeSeconds"
                                name="antiSnipeSeconds"
                                value={formData.antiSnipeSeconds}
                                onChange={handleChange}
                                required
                            >
                                <option value="300">5 minutes</option>
                                <option value="600">10 minutes</option>
                                <option value="900">15 minutes</option>
                                <option value="1800">30 minutes</option>
                            </select>
                            <small>Auction will extend by this duration if a bid is placed near the end</small>
                        </div>
                    </>
                )}

                {status && (
                    <div className="status-message">
                        {status}
                    </div>
                )}

                <div className="form-actions">
                    {!ownershipVerified && metadata ? (
                        <button type="button" className="hp-btn" disabled>
                            You don't own this NFT
                        </button>
                    ) : (
                        <button
                            type="submit"
                            className="hp-btn hp-btn--primary"
                            disabled={!wallet || !metadata || (typeof status === 'string' && status.includes('Creating')) || !ownershipVerified}
                        >
                            {typeof status === 'string' && status.includes('Creating') ? 'Processing...' : 'Create Auction'}
                        </button>
                    )}
                    
                    <button 
                        type="button" 
                        onClick={() => navigate('/marketplace')} 
                        className="hp-btn"
                    >
                        Cancel
                    </button>
                </div>
            </form>
        </div>
    );
}

export default CreateAuctionPage;