import React, { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useSearchParams, Link } from 'react-router-dom';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { fetchTokenPriceInUSDC } from '../utils/tokenUtils';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
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

            // NEW: data: URIs should be used as-is (no cache-buster)
            if (test.trim().toLowerCase().startsWith('data:')) {
                resolve(test);
                return;
            }

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

/* =========================================================
   V-Share LP fallback (custom) + description
   ========================================================= */
import { 
    VSHARE_ADDRESS, 
    vShareLpSvgDataUrl, 
    vShareDefaultDescription,
    isVShareContract 
} from '../utils/vShareUtils';

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

        // NEW: If any candidate is a data: URI, use it directly (don’t probe it)
        const dataUri = raws.find(u => u.trim().toLowerCase().startsWith('data:'));
        if (dataUri) {
            smartUrlCache.set(key, dataUri);
            if (!cancelled) {
                setFinalUrl(dataUri);
                setFailed(false);
            }
            return () => { cancelled = true; };
        }

        if (smartUrlCache.has(key)) {
            setFinalUrl(smartUrlCache.get(key));
            setFailed(false);
            return;
        }

        const candidates = uniq(flatten(raws.map(expandToCandidateUrls)));
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
   ABIs / Token addresses / Uniswap config
   ========================================================= */
const ERC721_ABI = [
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
];

const ERC1155_ABI = [
    'function uri(uint256 id) view returns (string)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
];

const UNISWAP_V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const UNISWAP_V3_POOL_ABI = [
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function fee() external view returns (uint24)',
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address owner) view returns (uint256)',
];

// Token addresses (Vitruveo chain)
const WVTRU_ADDRESS = '0x3ccc3F22462cAe34766820894D04a40381201ef9';
const USDC_ADDRESS = '0xbCfB3FCa16b12C7756CD6C24f1cC0AC0E38569CF';
const VUSD_ADDRESS = '0x1D607d8c617A09c638309bE2Ceb9b4afF42236dA';
const SEVO_ADDRESS = '0x2A34059DF3D60B1864f10F10492746bd26d3D24a';
const WSEVO_ADDRESS = '0x43a36604B6Ad9A4cf8EF600241E90b3DD97E145d';
const VITEX_ADDRESS = '0x4Ed92A1d95d2092973007197794542A5D51FF5a6';
const VTRO_ADDRESS = '0xDECAF2f187Cb837a42D26FA364349Abc3e80Aa5D';

// Uniswap V3 (Vitruveo)
const UNISWAP_V3_FACTORY_ADDRESS = '0x6196a7a6108B15a2cc24DdaB41C8CC3098C06351';
const FEE_TIERS = [500, 3000, 10000];

const ERC721_APPROVAL_ABI = [
    'function setApprovalForAll(address operator, bool approved) returns ()',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function approve(address to, uint256 tokenId) returns ()',
    'function getApproved(uint256 tokenId) view returns (address)',
];

const ERC1155_APPROVAL_ABI = [
    'function setApprovalForAll(address operator, bool approved) returns ()',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
];

/* =========================================================
   Component
   ========================================================= */
function SellPage() {
    const { createListing, status, setStatus, marketplaceAddress } = useMarketplace();
    const { wallet, connect, provider, signer } = useWallet();
    const [searchParams] = useSearchParams();
    const priceIntervalRef = useRef(null);
    const sellContainerRef = useRef(null);

    // Cursor parallax tracking for background effect
    const [mousePosition, setMousePosition] = useState({ x: 0.2, y: 0.3 });

    // Listing creation success state for confetti effect
    const [listingSuccess, setListingSuccess] = useState(false);

    // Progress tracking for the stepper
    const [sellProgress, setSellProgress] = useState(0);
    const [activeStep, setActiveStep] = useState('details');

    const [formData, setFormData] = useState({
        nftContract: searchParams.get('contract') || '',
        tokenId: searchParams.get('tokenId') || '',
        quantity: '1',
        price: '',
        paymentToken: ethers.ZeroAddress,
    });

    const [metadata, setMetadata] = useState(null);
    const [nftImage, setNftImage] = useState('');
    const [nftName, setNftName] = useState('');
    const [nftType, setNftType] = useState(null);
    const [balance, setBalance] = useState('0');
    const [loading, setLoading] = useState(false);
    const [ownershipVerified, setOwnershipVerified] = useState(false);

    const [displayPrice, setDisplayPrice] = useState({ wei: '', eth: '', usd: '' });
    const [tokenList, setTokenList] = useState({});
    const [paymentOptions, setPaymentOptions] = useState([]);
    const [loadingPrices, setLoadingPrices] = useState(false);
    const [showAddTokenForm, setShowAddTokenForm] = useState(false);
    const [customTokenData, setCustomTokenData] = useState({ address: '', symbol: '', name: '', decimals: '18', price: '' });
    const [customTokenError, setCustomTokenError] = useState('');

    const [livePrice, setLivePrice] = useState({});
    const [priceChange, setPriceChange] = useState({});
    const [lastUpdateTime, setLastUpdateTime] = useState(null);
    const [priceSources, setPriceSources] = useState({});
    const [priceErrors, setPriceErrors] = useState({});

    const [activePreviewTab, setActivePreviewTab] = useState('details');
    const [fees] = useState({ marketplaceFee: 2.5, creatorRoyalty: 5.0, networkFee: 0.001 });

    // New: marketplace fee (bps) and vibe share (bps) from contract
    const [platformFeeBps, setPlatformFeeBps] = useState(null);
    const [vibeShareBps, setVibeShareBps] = useState(null);

    const formatTime = (date) => (date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

    // Load platform fee and vibe share from contract
    useEffect(() => {
        const loadFees = async () => {
            try {
                if (!provider || !marketplaceAddress) return;
                const artifact = await import('../abi/VTRUNFTMarketplace.json');
                const abi = artifact.default?.abi || artifact.abi;
                const mkt = new ethers.Contract(marketplaceAddress, abi, provider);
                const [pf, vibe] = await Promise.all([
                    mkt.platformFeeBps().catch(() => null),
                    mkt.vibeShareBps().catch(() => null),
                ]);
                if (pf !== null) setPlatformFeeBps(Number(pf));
                if (vibe !== null) setVibeShareBps(Number(vibe));
            } catch (e) {
                debugWarn('Could not load marketplace fees (platform/vibe):', e);
            }
        };
        loadFees();
    }, [provider, marketplaceAddress]);

    // Cursor parallax effect
    useEffect(() => {
        const handleMouseMove = (e) => {
            if (!sellContainerRef.current) return;
            const rect = sellContainerRef.current.getBoundingClientRect();
            const x = (e.clientX - rect.left) / rect.width;
            const y = (e.clientY - rect.top) / rect.height;
            setMousePosition({ x, y });
            sellContainerRef.current.style.setProperty('--mx', x.toFixed(2));
            sellContainerRef.current.style.setProperty('--my', y.toFixed(2));
        };

        document.addEventListener('mousemove', handleMouseMove);
        return () => document.removeEventListener('mousemove', handleMouseMove);
    }, []);

    // Update progress based on form completion
    useEffect(() => {
        if (metadata) {
            if (formData.price && formData.paymentToken !== '') {
                setSellProgress(90);
                setActiveStep('pricing');
            } else if (ownershipVerified) {
                setSellProgress(60);
                setActiveStep('listing');
            } else {
                setSellProgress(30);
                setActiveStep('details');
            }
        } else {
            setSellProgress(formData.nftContract && formData.tokenId ? 15 : 0);
            setActiveStep('details');
        }
    }, [metadata, formData, ownershipVerified]);

    // Cleanup
    useEffect(() => {
        return () => {
            if (priceIntervalRef.current) clearInterval(priceIntervalRef.current);
        };
    }, []);

    // Field change (price has special handling)
    const handleChange = (e) => {
        const { id, value } = e.target;

        if (id === 'price') {
            setFormData({ ...formData, [id]: value });

            if (value && !isNaN(parseFloat(value))) {
                const token = tokenList[formData.paymentToken];
                if (token) {
                    try {
                        let usdValue = 'Unknown';
                        const currentPrice = livePrice[formData.paymentToken];
                        if (currentPrice) {
                            usdValue = (formData.paymentToken === USDC_ADDRESS)
                                ? parseFloat(value).toFixed(2)
                                : (parseFloat(value) * currentPrice).toFixed(2);
                        }
                        setDisplayPrice({
                            wei: ethers.parseUnits(value, token.decimals || 18).toString(),
                            eth: value,
                            usd: usdValue,
                        });
                    } catch {
                        setDisplayPrice({ wei: '0', eth: value, usd: 'Unknown' });
                    }
                }
            } else {
                setDisplayPrice({ wei: '0', eth: value || '0', usd: '0.00' });
            }
        } else {
            setFormData({ ...formData, [id]: value });
        }
    };

    // Submit -> approval then create listing (with success animation)
    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!wallet) {
            await connect();
            return;
        }
        if (!ownershipVerified) {
            setStatus('Error: Ownership not verified. You must own this NFT to list it.');
            return;
        }

        try {
            const mktAddr = await getMarketplaceAddress();
            if (!mktAddr) throw new Error("Couldn't determine marketplace address");

            if (nftType === 'ERC721') {
                setStatus('Checking NFT approval status...');
                const nft = new ethers.Contract(formData.nftContract, ERC721_APPROVAL_ABI, signer);
                const isAll = await nft.isApprovedForAll(wallet, mktAddr);
                if (!isAll) {
                    const approved = await nft.getApproved(formData.tokenId);
                    const ok = approved && approved.toLowerCase?.() === mktAddr.toLowerCase?.();
                    if (!ok) {
                        setStatus('Requesting approval to sell your NFT...');
                        const tx = await nft.setApprovalForAll(mktAddr, true);
                        setStatus('Confirming approval transaction...');
                        await tx.wait();
                        setStatus('Approval confirmed! Creating listing...');
                    }
                }
            } else if (nftType === 'ERC1155') {
                setStatus('Checking NFT approval status...');
                const nft = new ethers.Contract(formData.nftContract, ERC1155_APPROVAL_ABI, signer);
                const isAll = await nft.isApprovedForAll(wallet, mktAddr);
                if (!isAll) {
                    setStatus('Requesting approval to sell your NFT...');
                    const tx = await nft.setApprovalForAll(mktAddr, true);
                    setStatus('Confirming approval transaction...');
                    await tx.wait();
                    setStatus('Approval confirmed! Creating listing...');
                }
            }

            setStatus('Creating listing...');
            const token = tokenList[formData.paymentToken];
            const decimals = token ? token.decimals : 18;

            let priceInWei;
            try {
                priceInWei = ethers.parseUnits(formData.price, decimals).toString();
            } catch {
                setStatus('Error: Invalid price format');
                return;
            }

            await createListing(
                formData.nftContract,
                formData.tokenId,
                formData.quantity,
                priceInWei,
                formData.paymentToken
            );

            setListingSuccess(true);
            setSellProgress(100);
            setTimeout(() => {
                setListingSuccess(false);
            }, 3000);

        } catch (error) {
            setStatus(`Error: ${error.message || 'Could not create listing'}`);
        }
    };

    // Marketplace address
    const getMarketplaceAddress = async () => {
        if (marketplaceAddress) return marketplaceAddress;
        throw new Error('Marketplace address not available');
    };

    // Change payment token => recompute display USD
    const handlePaymentTokenChange = (e) => {
        const tokenAddress = e.target.value;
        setFormData({ ...formData, paymentToken: tokenAddress });

        if (formData.price && !isNaN(parseFloat(formData.price))) {
            const token = tokenList[tokenAddress];
            if (token) {
                try {
                    let usdValue = 'Unknown';
                    const currentPrice = livePrice[tokenAddress];
                    if (currentPrice) usdValue = (parseFloat(formData.price) * currentPrice).toFixed(2);
                    setDisplayPrice({
                        wei: ethers.parseUnits(formData.price, token.decimals || 18).toString(),
                        eth: formData.price,
                        usd: usdValue,
                    });
                } catch {
                    setDisplayPrice({ wei: '0', eth: formData.price, usd: 'Unknown' });
                }
            }
        }
    };

    /* =========================
       Token init + price fetching
       ========================= */
    useEffect(() => {
        if (!provider) return;
        const init = async () => {
            const initialized = await initializeTokens();
            await fetchUniswapPrices(0, initialized);
        };
        init().catch((err) => {
            criticalError(err);
            setStatus('Error initializing tokens. Please refresh the page.');
        });
    }, [provider]);

    const getUniswapPool = async (tokenA, tokenB) => {
        try {
            const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ABI, provider);
            for (const fee of FEE_TIERS) {
                try {
                    const poolAddress = await factory.getPool(tokenA, tokenB, fee);
                    if (poolAddress && poolAddress !== ethers.ZeroAddress) return { poolAddress, fee };
                } catch { }
            }
            return { poolAddress: null, fee: null };
        } catch {
            return { poolAddress: null, fee: null };
        }
    };

    const getUniswapPrice = async (tokenAddress) => {
        const price = await fetchTokenPriceInUSDC(tokenAddress, provider);
        const tokenSymbol = tokenList[tokenAddress]?.symbol || 'Unknown';
        let source;
        if (tokenAddress === ethers.ZeroAddress) source = 'Uniswap V3 (WVTRU proxy)';
        else if (tokenAddress === USDC_ADDRESS) source = 'USD Stablecoin';
        else source = `Uniswap V3 (${tokenSymbol}/USDC)`;
        return { price, source };
    };

    const fetchUniswapPrices = async (retryCount = 0, providedTokenList = null) => {
        const MAX_RETRIES = 3;
        theRetry: try {
            const RETRY_DELAY = 2000;
            const activeTokenList = providedTokenList || tokenList;
            if (!activeTokenList || Object.keys(activeTokenList).length === 0) return;

            const previousPrices = { ...livePrice };
            const newPrices = {};
            const changes = {};
            const newSources = { ...priceSources };
            const errors = {};

            newPrices[USDC_ADDRESS] = 1.0;
            newSources[USDC_ADDRESS] = 'USD Stablecoin';
            changes[USDC_ADDRESS] = 0;

            const entries = Object.entries(activeTokenList);

            // WVTRU first
            const wv = entries.find(([a]) => a === WVTRU_ADDRESS);
            if (wv) {
                const [address] = wv;
                try {
                    const { price, source } = await getUniswapPrice(address);
                    if (price && price > 0) {
                        newPrices[address] = price;
                        newSources[address] = source;
                        changes[address] = previousPrices[address] ? ((price - previousPrices[address]) / previousPrices[address]) * 100 : 0;
                    } else throw new Error('Invalid price');
                } catch (e) {
                    errors[address] = e.message || 'Unknown error';
                    if (previousPrices[address]) {
                        newPrices[address] = previousPrices[address];
                        changes[address] = 0;
                        newSources[address] = 'Outdated (fetch failed)';
                    } else {
                        newPrices[address] = null;
                        newSources[address] = 'No price data';
                    }
                }
            }

            // Others
            for (const [address] of entries) {
                if (address === USDC_ADDRESS || address === WVTRU_ADDRESS) continue;
                try {
                    const { price, source } = await getUniswapPrice(address);
                    if (price && price > 0) {
                        newPrices[address] = price;
                        newSources[address] = source;
                        changes[address] = previousPrices[address] ? ((price - previousPrices[address]) / previousPrices[address]) * 100 : 0;
                    } else throw new Error('Invalid price');
                } catch (e) {
                    errors[address] = e.message || 'Unknown error';
                    if (previousPrices[address]) {
                        newPrices[address] = previousPrices[address];
                        changes[address] = 0;
                        newSources[address] = 'Outdated (fetch failed)';
                    } else {
                        newPrices[address] = null;
                        newSources[address] = 'No price data';
                    }
                }
                await new Promise((r) => setTimeout(r, 100));
            }

            const validated = {};
            Object.entries(newPrices).forEach(([a, p]) => {
                validated[a] = typeof p === 'number' && p >= 0 ? p : null;
            });

            setLivePrice(validated);
            setPriceChange(changes);
            setPriceSources(newSources);
            setPriceErrors(errors);
            setLastUpdateTime(new Date());

            if (formData.price && formData.paymentToken && validated[formData.paymentToken]) {
                const usdValue = (parseFloat(formData.price) * validated[formData.paymentToken]).toFixed(2);
                setDisplayPrice((prev) => ({ ...prev, usd: usdValue }));
            }
        } catch (error) {
            if (retryCount < MAX_RETRIES && /(network|timeout|fetch)/i.test(error.message || '')) {
                setTimeout(() => fetchUniswapPrices(retryCount + 1, providedTokenList || tokenList), RETRY_DELAY);
            } else {
                setStatus('Warning: Some token prices could not be fetched. You can still create listings.');
            }
        }
    };

    const initializeTokens = async () => {
        setLoadingPrices(true);
        const initialTokens = {};
        try {
            initialTokens[ethers.ZeroAddress] = {
                address: ethers.ZeroAddress,
                symbol: 'VTRU',
                name: 'Native VTRU',
                decimals: 18,
                isNative: true,
            };

            // WVTRU
            try {
                const c = new ethers.Contract(WVTRU_ADDRESS, ERC20_ABI, provider);
                const [symbol, name, decimals] = await Promise.all([
                    c.symbol().catch(() => 'WVTRU'),
                    c.name().catch(() => 'Wrapped VTRU'),
                    c.decimals().catch(() => 18),
                ]);
                initialTokens[WVTRU_ADDRESS] = { address: WVTRU_ADDRESS, symbol, name, decimals };
            } catch {
                initialTokens[WVTRU_ADDRESS] = { address: WVTRU_ADDRESS, symbol: 'WVTRU', name: 'Wrapped VTRU', decimals: 18 };
            }

            // USDC
            try {
                const c = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
                const [symbol, name, decimals] = await Promise.all([
                    c.symbol().catch(() => 'USDC'),
                    c.name().catch(() => 'USD Coin'),
                    c.decimals().catch(() => 6),
                ]);
                initialTokens[USDC_ADDRESS] = { address: USDC_ADDRESS, symbol, name, decimals };
                setLivePrice((prev) => ({ ...prev, [USDC_ADDRESS]: 1.0 }));
                setPriceSources((prev) => ({ ...prev, [USDC_ADDRESS]: 'USD Stablecoin' }));
            } catch {
                initialTokens[USDC_ADDRESS] = { address: USDC_ADDRESS, symbol: 'USDC', name: 'USD Coin', decimals: 6 };
                setLivePrice((prev) => ({ ...prev, [USDC_ADDRESS]: 1.0 }));
                setPriceSources((prev) => ({ ...prev, [USDC_ADDRESS]: 'USD Stablecoin' }));
            }

            const addToken = async (addr, fallbackSymbol, fallbackName, fallbackDecimals = 18) => {
                try {
                    const c = new ethers.Contract(addr, ERC20_ABI, provider);
                    const [symbol, name, decimals] = await Promise.all([
                        c.symbol().catch(() => fallbackSymbol),
                        c.name().catch(() => fallbackName),
                        c.decimals().catch(() => fallbackDecimals),
                    ]);
                    initialTokens[addr] = { address: addr, symbol, name, decimals };
                } catch {
                    initialTokens[addr] = { address: addr, symbol: fallbackSymbol, name: fallbackName, decimals: fallbackDecimals };
                }
            };

            await addToken(VUSD_ADDRESS, 'VUSD', 'VUSD Token');
            await addToken(SEVO_ADDRESS, 'SEVO', 'SEVO Token');
            await addToken(WSEVO_ADDRESS, 'WSEVO', 'Wrapped SEVO');
            await addToken(VITEX_ADDRESS, 'VITEX', 'VITEX Token');
            await addToken(VTRO_ADDRESS, 'VTRO', 'VTRO Token');

            setTokenList(initialTokens);
            setLastUpdateTime(new Date());

            const options = Object.entries(initialTokens).map(([address, token]) => ({
                address,
                name: `${token.symbol}${token.isNative ? ' (Native)' : ''}`,
                fullName: token.name,
                symbol: token.symbol,
                price: address === USDC_ADDRESS ? 1.0 : null,
                priceSource: address === USDC_ADDRESS ? 'USD Stablecoin' : 'Price pending...',
                error: null,
            }));
            setPaymentOptions(options);

            return initialTokens;
        } catch (error) {
            setStatus('Error loading token information. Please refresh the page.');
            throw error;
        } finally {
            setLoadingPrices(false);
        }
    };

    const buildPaymentOptions = () => {
        if (!tokenList || Object.keys(tokenList).length === 0) {
            setPaymentOptions([]);
            return;
        }
        const options = Object.entries(tokenList).map(([address, token]) => {
            const price = livePrice[address];
            const priceSource = priceSources[address] || 'Unknown';
            const error = priceErrors[address];
            const validPrice = typeof price === 'number' && price > 0 ? price : null;
            return {
                address,
                name: `${token.symbol}${token.isNative ? ' (Native)' : ''}`,
                fullName: token.name,
                symbol: token.symbol,
                price: validPrice,
                priceSource,
                error,
            };
        });
        setPaymentOptions(options);
    };

    useEffect(() => {
        if (Object.keys(tokenList).length > 0) buildPaymentOptions();
    }, [tokenList, livePrice, priceSources, priceErrors]);

    const handleCustomTokenChange = (e) => {
        const { id, value } = e.target;
        setCustomTokenData({ ...customTokenData, [id]: value });
    };

    const addCustomToken = async () => {
        setCustomTokenError('');

        if (!ethers.isAddress(customTokenData.address)) {
            setCustomTokenError('Invalid address format');
            return;
        }

        try {
            const checksum = ethers.getAddress(customTokenData.address);
            if (tokenList[checksum]) {
                setCustomTokenError('Token already added');
                return;
            }

            setLoadingPrices(true);
            const c = new ethers.Contract(checksum, ERC20_ABI, provider);

            let symbol, name, decimals;
            try {
                symbol = await c.symbol();
                name = await c.name();
                decimals = await c.decimals();
            } catch {
                symbol = customTokenData.symbol || 'UNKNOWN';
                name = customTokenData.name || 'Custom Token';
                decimals = parseInt(customTokenData.decimals) || 18;
            }

            const newToken = { address: checksum, symbol, name, decimals };
            setTokenList((prev) => ({ ...prev, [checksum]: newToken }));

            if (customTokenData.price) {
                const manual = parseFloat(customTokenData.price);
                setLivePrice((prev) => ({ ...prev, [checksum]: manual }));
                setPriceSources((prev) => ({ ...prev, [checksum]: 'Manually entered' }));
            } else {
                setPriceSources((prev) => ({ ...prev, [checksum]: 'Fetching from Uniswap...' }));
            }

            setCustomTokenData({ address: '', symbol: '', name: '', decimals: '18', price: '' });
            setShowAddTokenForm(false);
        } catch (error) {
            setCustomTokenError(`Error adding token: ${error.message}`);
        } finally {
            setLoadingPrices(false);
        }
    };

    /* =========================
       NFT metadata (robust + tolerant)
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
            const tokenIdStr = String(formData.tokenId);

            const setFallback = (type, qty = '1', nameTitle = `NFT #${tokenIdStr}`) => {
                const isVShare = isVShareContract(checksum);
                const fallback = isVShare
                    ? vShareLpSvgDataUrl({ contract: checksum, tokenId: tokenIdStr, title: 'V-Share', subtitle: 'Vmonsters Rev Share' })
                    : svgFallbackDataUrl({ seed: `${checksum}-${tokenIdStr}`, width: 640, height: 460, title: nameTitle });

                const desc = isVShare ? vShareDefaultDescription() : 'Metadata unavailable';

                setMetadata({ name: nameTitle, description: desc, image: fallback, attributes: [] });
                setNftName(nameTitle);
                setNftImage(fallback);
                setNftType(type);
                setBalance(qty);
                setStatus('Warning: Metadata unavailable. Using a safe SVG preview. You can still list this NFT.');
            };

            // ERC721 path
            try {
                const erc721 = new ethers.Contract(checksum, ERC721_ABI, provider);
                const owner = await erc721.ownerOf(formData.tokenId);
                const isOwner = (owner || '').toLowerCase() === (wallet || '').toLowerCase();
                setOwnershipVerified(isOwner);
                if (!isOwner) { setStatus('Warning: You are not the owner of this NFT'); setLoading(false); return; }

                setNftType('ERC721');
                setBalance('1');

                let tokenURI = null;
                try { tokenURI = await erc721.tokenURI(formData.tokenId); } catch { }
                if (!tokenURI) { setFallback('ERC721', '1'); setLoading(false); return; }

                try {
                    const metaCands = metadataCandidatesFromUri(tokenURI, formData.tokenId, false);
                    const { json } = await fetchJsonFromCandidates(metaCands);
                    setMetadata(json);
                    setNftName(json?.name || `NFT #${tokenIdStr}`);
                    try {
                        const media = uniq(flatten(mediaCandidatesFromMetadata(json).map(expandToCandidateUrls)));
                        const firstVideo = media.find(isVideoUrl);
                        if (firstVideo) setNftImage(firstVideo);
                        else setNftImage(await findFirstWorkingImage(media));
                    } catch {
                        const isVShare = isVShareContract(checksum);
                        const fallback = isVShare
                            ? vShareLpSvgDataUrl({ contract: checksum, tokenId: tokenIdStr, title: json?.name || `NFT #${tokenIdStr}` })
                            : svgFallbackDataUrl({ seed: `${checksum}-${tokenIdStr}`, width: 640, height: 460, title: json?.name || `NFT #${tokenIdStr}` });
                        setNftImage(fallback);
                    }
                    setStatus('');
                } catch {
                    setFallback('ERC721', '1');
                }
                setLoading(false);
                return;
            } catch {
                // Continue to ERC1155
            }

            // ERC1155 path
            try {
                const erc1155 = new ethers.Contract(checksum, ERC1155_ABI, provider);
                const bal = await erc1155.balanceOf(wallet, formData.tokenId);
                const qty = bal.toString();
                if (qty === '0') { setStatus('Warning: You do not own any of these tokens'); setLoading(false); return; }
                setOwnershipVerified(true);
                setNftType('ERC1155');
                setBalance(qty);

                let uri = null;
                try { uri = await erc1155.uri(formData.tokenId); } catch { }
                if (!uri) { setFallback('ERC1155', qty); setLoading(false); return; }

                try {
                    const metaCands = metadataCandidatesFromUri(uri, formData.tokenId, true);
                    const { json } = await fetchJsonFromCandidates(metaCands);
                    setMetadata(json);
                    setNftName(json?.name || `NFT #${tokenIdStr}`);
                    try {
                        const media = uniq(flatten(mediaCandidatesFromMetadata(json).map(expandToCandidateUrls)));
                        const firstVideo = media.find(isVideoUrl);
                        if (firstVideo) setNftImage(firstVideo);
                        else setNftImage(await findFirstWorkingImage(media));
                    } catch {
                        const isVShare = isVShareContract(checksum);
                        const fallback = isVShare
                            ? vShareLpSvgDataUrl({ contract: checksum, tokenId: tokenIdStr, title: json?.name || `NFT #${tokenIdStr}` })
                            : svgFallbackDataUrl({ seed: `${checksum}-${tokenIdStr}`, width: 640, height: 460, title: json?.name || `NFT #${tokenIdStr}` });
                        setNftImage(fallback);
                    }
                    setFormData((prev) => ({ ...prev, quantity: qty }));
                    setStatus('');
                } catch {
                    setFallback('ERC1155', qty);
                }
            } catch {
                setStatus('Could not determine NFT standard or fetch metadata. Double-check contract/token ID.');
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
       Proceeds & rarity helpers
       ========================= */
    const calculateProceeds = () => {
        if (!displayPrice.eth || !formData.quantity)
            return {
                subtotal: '0',
                marketplaceFee: '0',
                royaltyFee: '0',
                total: '0',
                usdValue: '0',
                vibeFee: '0',
                vibePctOfSale: 0,
            };

        const quantity = parseFloat(formData.quantity || '1');
        const pricePerUnit = parseFloat(displayPrice.eth || '0');
        const subtotal = quantity * pricePerUnit;

        // Use on-chain platformFeeBps if available, else fallback to fixed 2.5%
        const pfBps = platformFeeBps !== null ? platformFeeBps : Math.round((fees.marketplaceFee || 2.5) * 100);
        const marketplaceFeeAmount = subtotal * (pfBps / 10000);

        // Vibe fee is a portion of the platform fee (not an extra deduction for sellers)
        const vibeBps = vibeShareBps !== null ? vibeShareBps : null;
        const vibeFeeAmount = vibeBps !== null ? marketplaceFeeAmount * (vibeBps / 10000) : 0;
        const vibePctOfSale = vibeBps !== null ? (pfBps * vibeBps) / 1_000_000 : 0; // percent of sale

        const royaltyFeeAmount = subtotal * ((fees.creatorRoyalty || 0) / 100);
        const total = subtotal - marketplaceFeeAmount - royaltyFeeAmount;

        let usdValue = 'Unknown';
        const currentPrice = livePrice[formData.paymentToken];
        if (currentPrice) usdValue = (total * currentPrice).toFixed(2);

        return {
            subtotal: subtotal.toFixed(6),
            marketplaceFee: marketplaceFeeAmount.toFixed(6),
            royaltyFee: royaltyFeeAmount.toFixed(6),
            total: total.toFixed(6),
            usdValue,
            vibeFee: vibeFeeAmount.toFixed(6),
            vibePctOfSale,
        };
    };

    const proceeds = calculateProceeds();

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

    /* =========================
       UI with enhanced styling
       ========================= */
    return (
        <div className="sell-container" ref={sellContainerRef}>
            <div className="page-header">
                <h1>Sell Your NFT</h1>
                <p>Create a listing for your digital asset</p>
                <div className="selling-options">
                    <p className="options-intro">Choose how you want to sell:</p>
                    <div className="sell-buttons">
                        <span className="current-option">📋 Fixed Price Listing</span>
                        <Link to="/auctions/create" className="alt-option">
                            🔨 Create Auction
                        </Link>
                    </div>
                </div>
            </div>

            {/* Price Ticker with Uniswap Price Data */}
            {Object.keys(livePrice).length > 0 && (
                <div className="price-ticker">
                    <div className="ticker-header">
                        <span>Uniswap V3 Token Prices</span>
                        <span className="ticker-time">Last updated: {formatTime(lastUpdateTime)}</span>
                    </div>
                    <div className="ticker-items">
                        {Object.entries(tokenList)
                            .filter(([address]) => livePrice[address] !== null)
                            .map(([address, token]) => {
                                const price = livePrice[address];
                                const change = priceChange[address] || 0;
                                const source = priceSources[address];
                                const error = priceErrors[address];

                                return (
                                    <div className={`ticker-item ${error ? 'has-error' : ''}`} key={address}>
                                        <div className="ticker-symbol">{token.symbol}</div>
                                        {price ? (
                                            <>
                                                <div className="ticker-price">${price.toFixed(4)}</div>
                                                <div className={`ticker-change ${change > 0 ? 'positive' : change < 0 ? 'negative' : ''}`}>
                                                    {change > 0 ? '+' : ''}
                                                    {change.toFixed(2)}%
                                                </div>
                                            </>
                                        ) : (
                                            <div className="ticker-no-price">No Price Data</div>
                                        )}
                                        <div className="ticker-source" title={error || source}>{error ? 'Error' : source}</div>
                                    </div>
                                );
                            })}
                        <div className="ticker-refresh" onClick={() => fetchUniswapPrices()} title="Refresh Uniswap Prices">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                            </svg>
                        </div>
                    </div>
                </div>
            )}

            <div className="sell-layout">
                <div className="sell-form">
                    <div className={`card glow-card ${listingSuccess ? 'confetti' : ''}`}>
                        <form onSubmit={handleSubmit}>
                            <div className="form-section">
                                <h3>NFT Details</h3>

                                <div className="form-group">
                                    <label htmlFor="nftContract">NFT Contract Address</label>
                                    <input
                                        type="text"
                                        id="nftContract"
                                        className="input"
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
                                        className="input"
                                        value={formData.tokenId}
                                        onChange={handleChange}
                                        placeholder="1"
                                        required
                                    />
                                </div>

                                {!metadata && !loading && (
                                    <button type="button" className="secondary-button fetch-button" onClick={fetchNftMetadata}>
                                        Fetch NFT Data
                                    </button>
                                )}

                                {loading && (
                                    <div className="form-group">
                                        <div className="skeleton text"></div>
                                        <div className="skeleton block"></div>
                                    </div>
                                )}
                            </div>

                            {nftType && (
                                <div className="form-section">
                                    <h3>Listing Details</h3>

                                    <div className="form-group">
                                        <label htmlFor="quantity">Quantity to Sell</label>
                                        <div className="input-with-info">
                                            <input
                                                type="number"
                                                id="quantity"
                                                className="input"
                                                value={formData.quantity}
                                                onChange={handleChange}
                                                placeholder="1"
                                                min="1"
                                                max={balance}
                                                required
                                            />
                                            <div className="input-info">
                                                Available: <span className="chip">{balance}</span>
                                            </div>
                                        </div>
                                        {nftType === 'ERC721' && <div className="small">ERC-721 NFTs are unique and quantity will be 1</div>}
                                    </div>

                                    <div className="form-group">
                                        <label htmlFor="price">Price per Unit</label>
                                        <div className="price-input-container">
                                            <input
                                                type="text"
                                                id="price"
                                                className="input price-input"
                                                value={formData.price}
                                                onChange={handleChange}
                                                placeholder="0.00"
                                                required
                                            />
                                            <div className="price-conversion">
                                                <div className="price-eth">
                                                    {displayPrice.eth} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                </div>
                                                <div className="price-usd">
                                                    ≈ {displayPrice.usd === 'Unknown' ? 'Unknown USD value' : `$${displayPrice.usd} USD`}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Payment token selector with enhanced UI */}
                                    <div className="form-group">
                                        <div className="payment-header">
                                            <label>Payment Token</label>
                                            <button
                                                type="button"
                                                className="add-token-button"
                                                onClick={() => setShowAddTokenForm(!showAddTokenForm)}
                                            >
                                                {showAddTokenForm ? 'Cancel' : '+ Add Custom Token'}
                                            </button>
                                        </div>

                                        {showAddTokenForm && (
                                            <div className="custom-token-form">
                                                <h4>Add Custom Token</h4>

                                                <div className="form-group">
                                                    <label htmlFor="address">Token Address *</label>
                                                    <input
                                                        type="text"
                                                        id="address"
                                                        className="input"
                                                        value={customTokenData.address}
                                                        onChange={handleCustomTokenChange}
                                                        placeholder="0x..."
                                                        required
                                                    />
                                                </div>

                                                <div className="form-row">
                                                    <div className="form-group">
                                                        <label htmlFor="symbol">Symbol</label>
                                                        <input
                                                            type="text"
                                                            id="symbol"
                                                            className="input"
                                                            value={customTokenData.symbol}
                                                            onChange={handleCustomTokenChange}
                                                            placeholder="Auto-detect if available"
                                                        />
                                                    </div>
                                                    <div className="form-group">
                                                        <label htmlFor="decimals">Decimals</label>
                                                        <input
                                                            type="number"
                                                            id="decimals"
                                                            className="input"
                                                            value={customTokenData.decimals}
                                                            onChange={handleCustomTokenChange}
                                                            placeholder="18"
                                                        />
                                                    </div>
                                                </div>

                                                <div className="form-group">
                                                    <label htmlFor="name">Token Name</label>
                                                    <input
                                                        type="text"
                                                        id="name"
                                                        className="input"
                                                        value={customTokenData.name}
                                                        onChange={handleCustomTokenChange}
                                                        placeholder="Auto-detect if available"
                                                    />
                                                </div>

                                                <div className="form-group">
                                                    <label htmlFor="price">USD Price (optional)</label>
                                                    <div className="input-with-info">
                                                        <input
                                                            type="number"
                                                            id="price"
                                                            className="input"
                                                            value={customTokenData.price}
                                                            onChange={handleCustomTokenChange}
                                                            placeholder="Token USD price"
                                                            step="0.000001"
                                                        />
                                                        <div className="input-info">Will try to find Uniswap pool if left empty</div>
                                                    </div>
                                                </div>

                                                {customTokenError && <div className="error-message">{customTokenError}</div>}

                                                <div className="form-actions token-actions">
                                                    <button type="button" className="secondary-button" onClick={() => setShowAddTokenForm(false)}>
                                                        Cancel
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="primary-button"
                                                        onClick={addCustomToken}
                                                        disabled={!customTokenData.address || loadingPrices}
                                                    >
                                                        {loadingPrices ? 'Adding...' : 'Add Token'}
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {loadingPrices && !showAddTokenForm ? (
                                            <div className="loading-tokens">
                                                <div className="loader"></div>
                                                <p>Loading token information from Uniswap...</p>
                                            </div>
                                        ) : (
                                            <div className="token-dropdown-container">
                                                <div className="token-dropdown-wrapper">
                                                    <select className="token-dropdown" value={formData.paymentToken} onChange={handlePaymentTokenChange}>
                                                        <option value="" disabled>
                                                            Select payment token
                                                        </option>
                                                        {paymentOptions.map((option) => (
                                                            <option key={option.address} value={option.address}>
                                                                {option.name} - $
                                                                {option.price !== null
                                                                    ? option.price < 0.01
                                                                        ? option.price.toFixed(6)
                                                                        : option.price.toFixed(2)
                                                                    : 'No price'}{' '}
                                                                USD
                                                            </option>
                                                        ))}
                                                    </select>
                                                    <div className="dropdown-icon">
                                                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                                            <path d="M7 10l5 5 5-5z" />
                                                        </svg>
                                                    </div>
                                                </div>

                                                {formData.paymentToken && paymentOptions.length > 0 && (
                                                    <div className="selected-token-details">
                                                        {(() => {
                                                            const selected = paymentOptions.find((o) => o.address === formData.paymentToken);
                                                            if (!selected) return null;

                                                            return (
                                                                <div className={`token-details-card ${selected.error ? 'has-error' : ''}`}>
                                                                    <div className="token-details-header">
                                                                        <div className="token-details-info">
                                                                            <div className="token-details-name">{selected.name}</div>
                                                                            <div className="token-details-full-name">{selected.fullName}</div>
                                                                        </div>
                                                                        <div className="token-details-price-info">
                                                                            {selected.price !== null ? (
                                                                                <div className="token-details-price">
                                                                                    ${selected.price < 0.01 ? selected.price.toFixed(6) : selected.price.toFixed(2)} USD
                                                                                </div>
                                                                            ) : (
                                                                                <div className="token-details-price-unknown">No price data</div>
                                                                            )}
                                                                            <div className={`token-details-source ${selected.error ? 'error' : ''}`} title={selected.error}>
                                                                                {selected.error ? '⚠️ ' + selected.error : selected.priceSource}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })()}
                                                    </div>
                                                )}

                                                {paymentOptions.length === 0 && <div className="no-tokens-message">No tokens available. Add a custom token to continue.</div>}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            <div className="form-actions">
                                <div className="approval-note">
                                    <svg viewBox="0 0 24 24" width="16" height="16">
                                        <path
                                            fill="currentColor"
                                            d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
                                        />
                                    </svg>
                                    <span>Note: You'll need to approve the marketplace to transfer your NFT. This is a one-time action per collection.</span>
                                </div>

                                {!wallet ? (
                                    <button type="button" className="secondary-button" onClick={connect}>
                                        Connect Wallet First
                                    </button>
                                ) : !ownershipVerified && metadata ? (
                                    <button type="button" className="warning-button" disabled>
                                        You don't own this NFT
                                    </button>
                                ) : (
                                    <button
                                        type="submit"
                                        className="primary-button"
                                        disabled={!wallet || !ownershipVerified || (typeof status === 'string' && status.includes('Creating'))}
                                    >
                                        {typeof status === 'string' && status.includes('Creating') ? 'Processing...' : 'List NFT for Sale'}
                                    </button>
                                )}
                            </div>

                            {status && (
                                <div className={`status-message ${String(status).includes('Warning') ? 'warning' : ''}`}>
                                    {status.includes('Error') ? (
                                        <span className="chip error">{status}</span>
                                    ) : status.includes('Warning') ? (
                                        <span className="chip warn">{status}</span>
                                    ) : status.includes('Success') ? (
                                        <span className="chip success">{status}</span>
                                    ) : (
                                        status
                                    )}
                                </div>
                            )}
                        </form>
                    </div>
                </div>

                {/* Preview with 3D tilt effect */}
                <div className="nft-preview">
                    {loading ? (
                        <div className="preview-loading">
                            <div className="loader"></div>
                            <p>Loading NFT data...</p>
                        </div>
                    ) : metadata ? (
                        <div className="premium-preview tilt-3d">
                            <div className="preview-header">
                                <div className="preview-badge">{nftType || 'NFT'}</div>
                                {ownershipVerified && (
                                    <div className="ownership-badge">
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="#22cc88">
                                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                                        </svg>
                                        <span>Verified Owner</span>
                                    </div>
                                )}
                            </div>

                            <div className="premium-image-container">
                                <div className="premium-image-wrapper">
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
                                        width={640}
                                        height={460}
                                        seed={`${String(formData.nftContract)}-${String(formData.tokenId)}`}
                                        title={nftName}
                                        className="premium-image"
                                    />
                                    {isString(nftImage) && (
                                        <div className="image-overlay">
                                            <a
                                                href={expandToCandidateUrls(nftImage)[0] || nftImage}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="zoom-button"
                                                title="View Full Size"
                                            >
                                                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                                                    <path d="M15 3l2.3 2.3-2.89 2.87 1.42 1.42L18.7 6.7 21 9V3h-6zM3 9l2.3-2.3 2.87 2.89 1.42-1.42L6.7 5.3 9 3H3v6zm6 12l-2.3-2.3 2.89-2.87-1.42-1.42L5.3 17.3 3 15v6h6zm12-6l-2.3 2.3-2.87-2.89-1.42 1.42 2.89 2.87L15 21h6v-6z" />
                                                </svg>
                                            </a>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="preview-title-section">
                                <h2 className="preview-name">{nftName}</h2>
                                <div className="preview-contract">
                                    <span className="contract-label">Contract:</span>
                                    <span className="contract-address">{`${formData.nftContract.slice(0, 6)}...${formData.nftContract.slice(-4)}`}</span>
                                    <span className="token-id">#{formData.tokenId}</span>
                                </div>
                            </div>

                            <div className="preview-tabs">
                                <button className={activePreviewTab === 'details' ? 'active' : ''} onClick={() => setActivePreviewTab('details')}>
                                    Details
                                </button>
                                <button className={activePreviewTab === 'properties' ? 'active' : ''} onClick={() => setActivePreviewTab('properties')}>
                                    Properties
                                </button>
                                <button className={activePreviewTab === 'pricing' ? 'active' : ''} onClick={() => setActivePreviewTab('pricing')}>
                                    Pricing & Fees
                                </button>
                            </div>

                            <div className="preview-tab-content">
                                {activePreviewTab === 'details' && (
                                    <div className="details-tab">
                                        <div className="preview-description">
                                            <h4>Description</h4>
                                            <p>{metadata?.description || 'No description available'}</p>
                                        </div>

                                        <div className="preview-details">
                                            <div className="detail-row">
                                                <span className="detail-label">Token Standard</span>
                                                <span className="detail-value">{nftType}</span>
                                            </div>
                                            <div className="detail-row">
                                                <span className="detail-label">Contract</span>
                                                <span className="detail-value">
                                                    <a href={`https://explorer.vitruveo.xyz/address/${formData.nftContract}`} target="_blank" rel="noopener noreferrer">
                                                        {`${formData.nftContract.slice(0, 6)}...${formData.nftContract.slice(-4)}`}
                                                    </a>
                                                </span>
                                            </div>
                                            <div className="detail-row">
                                                <span className="detail-label">Token ID</span>
                                                <span className="detail-value">#{formData.tokenId}</span>
                                            </div>
                                            {nftType === 'ERC1155' && (
                                                <div className="detail-row">
                                                    <span className="detail-label">Quantity Owned</span>
                                                    <span className="detail-value">{balance}</span>
                                                </div>
                                            )}
                                            <div className="detail-row">
                                                <span className="detail-label">Owner</span>
                                                <span className="detail-value">
                                                    {ownershipVerified ? (
                                                        <>
                                                            <span className="owner-you">You</span>
                                                            <span className="owner-address">({`${wallet.slice(0, 6)}...${wallet.slice(-4)}`})</span>
                                                        </>
                                                    ) : (
                                                        <span className="not-owned">Not owned by you</span>
                                                    )}
                                                </span>
                                            </div>
                                        </div>

                                        {isString(metadata?.external_url) && (
                                            <div className="external-link">
                                                <h4>External Link</h4>
                                                <a href={metadata.external_url} target="_blank" rel="noopener noreferrer">
                                                    {metadata.external_url}
                                                </a>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activePreviewTab === 'properties' && (
                                    <div className="properties-tab">
                                        <h4>Properties</h4>
                                        {Array.isArray(metadata?.attributes) && metadata.attributes.length > 0 ? (
                                            <div className="attributes-grid">
                                                {metadata.attributes.map((attr, index) => {
                                                    const rarity = getTraitRarity(attr);
                                                    return (
                                                        <div key={index} className="attribute-box" style={{ borderColor: rarity.color }}>
                                                            <div className="attribute-type" style={{ color: rarity.color }}>
                                                                {attr.trait_type || 'Property'}
                                                            </div>
                                                            <div className="attribute-value">{attr.value?.toString() || 'Unknown'}</div>
                                                            <div className="attribute-rarity" style={{ backgroundColor: rarity.color }}>
                                                                {rarity.label} ({rarity.percentage})
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ) : (
                                            <div className="no-attributes">
                                                <p>This NFT doesn't have any properties</p>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activePreviewTab === 'pricing' && (
                                    <div className="pricing-tab">
                                        <div className="pricing-summary">
                                            <div className="pricing-row">
                                                <div className="pricing-label">Listing Subtotal</div>
                                                <div className="pricing-value">
                                                    <span>
                                                        {proceeds.subtotal} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                    </span>
                                                    <span className="pricing-usd">
                                                        {proceeds.usdValue === 'Unknown' ? '(USD value unknown)' : `($${proceeds.usdValue})`}
                                                    </span>
                                                </div>
                                            </div>

                                            <div className="pricing-row fee">
                                                <div className="pricing-label">
                                                    <span>
                                                        Marketplace Fee (
                                                        {platformFeeBps !== null
                                                            ? (platformFeeBps / 100).toFixed(2)
                                                            : (fees.marketplaceFee || 2.5).toFixed(2)
                                                        }
                                                        %)
                                                    </span>
                                                    <span className="info-icon" title="Fee charged by the marketplace">
                                                        ⓘ
                                                    </span>
                                                </div>
                                                <div className="pricing-value negative">
                                                    -{proceeds.marketplaceFee} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                </div>
                                            </div>

                                            {/* New: Vibe Fee breakdown (part of marketplace fee) */}
                                            {vibeShareBps !== null && (
                                                <div className="pricing-row" style={{ opacity: 0.85 }}>
                                                    <div className="pricing-label">
                                                        <span>
                                                            Vibe Fee ({(vibeShareBps / 100).toFixed(2)}% of marketplace fee
                                                            {platformFeeBps !== null ? ` • ≈ ${proceeds.vibePctOfSale.toFixed(2)}% of sale` : ''})
                                                        </span>
                                                        <span className="info-icon" title="Portion of the marketplace fee allocated to the Vibe program">
                                                            ⓘ
                                                        </span>
                                                    </div>
                                                    <div className="pricing-value">
                                                        {proceeds.vibeFee} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                    </div>
                                                </div>
                                            )}

                                            <div className="pricing-row fee">
                                                <div className="pricing-label">
                                                    <span>Creator Royalty ({(fees.creatorRoyalty || 0).toFixed(2)}%)</span>
                                                    <span className="info-icon" title="Royalty paid to the original creator">
                                                        ⓘ
                                                    </span>
                                                </div>
                                                <div className="pricing-value negative">
                                                    -{proceeds.royaltyFee} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                </div>
                                            </div>

                                            <div className="pricing-divider"></div>

                                            <div className="pricing-row total">
                                                <div className="pricing-label">You'll Receive</div>
                                                <div className="pricing-value">
                                                    <span>
                                                        {proceeds.total} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                    </span>
                                                    <span className="pricing-usd">
                                                        {proceeds.usdValue === 'Unknown' ? '(USD value unknown)' : `($${proceeds.usdValue})`}
                                                    </span>
                                                </div>
                                            </div>

                                            <div className="network-fee-note">
                                                <svg viewBox="0 0 24 24" width="16" height="16">
                                                    <path
                                                        fill="currentColor"
                                                        d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
                                                    />
                                                </svg>
                                                <span>Estimated network fee: {fees.networkFee} VTRU</span>
                                            </div>

                                            <div className="price-source-note">
                                                <span>Price source: {priceSources[formData.paymentToken] || 'Unknown'}</span>
                                                <a
                                                    href="#"
                                                    onClick={(e) => {
                                                        e.preventDefault();
                                                        fetchUniswapPrices();
                                                    }}
                                                    className="refresh-link"
                                                >
                                                    Refresh Uniswap prices
                                                </a>
                                            </div>

                                            {formData.paymentToken === ethers.ZeroAddress && (
                                                <div className="pricing-note">
                                                    <svg viewBox="0 0 24 24" width="16" height="16">
                                                        <path
                                                            fill="currentColor"
                                                            d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
                                                        />
                                                    </svg>
                                                    <span>Native VTRU uses WVTRU price from Uniswap</span>
                                                </div>
                                            )}

                                            {priceErrors[formData.paymentToken] && (
                                                <div className="price-error-warning">
                                                    <svg viewBox="0 0 24 24" width="16" height="16">
                                                        <path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
                                                    </svg>
                                                    <span>Price error: {priceErrors[formData.paymentToken]}</span>
                                                </div>
                                            )}
                                        </div>

                                        <div className="pricing-explainer">
                                            <h4>How our fees work</h4>
                                            <p>
                                                Our marketplace fee is taken from each sale. A portion of that fee (the Vibe fee) is allocated to the Vibe program.
                                                Creator royalties ensure original creators are compensated for their work.
                                            </p>
                                            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.2rem', color: 'var(--hp-muted, #a6accd)' }}>
                                                <li>
                                                    Marketplace Fee:{' '}
                                                    {platformFeeBps !== null
                                                        ? (platformFeeBps / 100).toFixed(2) + '%'
                                                        : (fees.marketplaceFee || 2.5).toFixed(2) + '%'}

                                                </li>
                                                {vibeShareBps !== null && (
                                                    <li>
                                                        Vibe Fee: {(vibeShareBps / 100).toFixed(2)}% of marketplace fee
                                                        {platformFeeBps !== null ? ` (~${proceeds.vibePctOfSale.toFixed(2)}% of sale)` : ''}
                                                    </li>
                                                )}
                                                <li>Creator Royalty: {(fees.creatorRoyalty || 0).toFixed(2)}%</li>
                                            </ul>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="empty-preview">
                            <div className="empty-preview-icon">🖼️</div>
                            <h3>NFT Preview</h3>
                            <p>Enter contract address and token ID to load NFT details</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default SellPage;