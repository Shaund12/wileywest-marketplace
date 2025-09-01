import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { useSupabase } from '../context/SupabaseContext';
import { formatTokenAmount, getTokenInfo } from '../utils/tokenRegistry';
import { fetchTokenPriceInUSDC } from '../utils/tokenUtils';
import { loadNFTMetadata as loadMetadata } from '../utils/metadataLoader';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
import './AuctionStyles.css';
import './SellPage.css';

/* =========================================================
   IPFS/IPNS/Arweave + SmartMedia (self-contained utilities)
   ========================================================= */
const IPFS_GATEWAYS = [
    'https://ipfs.io/ipfs/',              // Official gateway - most reliable
    'https://dweb.link/ipfs/',            // Protocol Labs gateway
    'https://gateway.pinata.cloud/ipfs/', // Pinata gateway - good CORS support
    'https://w3s.link/ipfs/',             // Web3.Storage gateway
    'https://nftstorage.link/ipfs/',      // NFT.Storage gateway
    'https://4everland.io/ipfs/',         // 4everland gateway
];

const IPNS_GATEWAYS = [
    'https://ipfs.io/ipns/',              // Official gateway - most reliable
    'https://dweb.link/ipns/',            // Protocol Labs gateway
    'https://gateway.pinata.cloud/ipns/', // Pinata gateway - good CORS support
    'https://w3s.link/ipns/',             // Web3.Storage gateway
    'https://nftstorage.link/ipns/',      // NFT.Storage gateway
    'https://4everland.io/ipns/',         // 4everland gateway
];

const isString = (v) => typeof v === 'string' && v.trim().length > 0;
const uniq = (arr) => Array.from(new Set(arr));
const flatten = (arrs) => arrs.reduce((a, b) => a.concat(b), []);
const isVideoUrl = (u) => isString(u) && /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(u);

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

function AuctionDetailPage() {
    const { id: auctionId } = useParams();
    const navigate = useNavigate();
    const { wallet, connect, provider, signer } = useWallet();
    const { status, marketplaceAddress } = useMarketplace();
    const { getCachedAuctions, getAuctionBids } = useSupabase();
    const [auction, setAuction] = useState(null);
    const [loading, setLoading] = useState(true);
    const [bidAmount, setBidAmount] = useState('');
    const [bidding, setBidding] = useState(false);
    const [settling, setSettling] = useState(false);
    const [timeLeft, setTimeLeft] = useState(0);
    const [currentPrice, setCurrentPrice] = useState(null);
    const [activeTab, setActiveTab] = useState('details');
    const [nftMetadata, setNftMetadata] = useState({});
    const [bids, setBids] = useState([]);

    // Set document title
    useEffect(() => {
        document.title = 'Auction • BlockDust';
    }, []);

    useEffect(() => {
        loadAuction();
    }, [auctionId, provider, marketplaceAddress]);

    useEffect(() => {
        // Update countdown timer
        if (auction && auction.endTime) {
            const timer = setInterval(() => {
                const now = Math.floor(Date.now() / 1000);
                const remaining = auction.endTime - now;
                setTimeLeft(Math.max(0, remaining));
            }, 1000);

            return () => clearInterval(timer);
        }
    }, [auction]);

    useEffect(() => {
        // Fetch current token price
        if (auction && provider && auction.paymentToken) {
            // Validate that auction.paymentToken is not undefined
            const paymentToken = auction.paymentToken;
            if (paymentToken && paymentToken !== 'undefined' && paymentToken !== 'null') {
                fetchTokenPriceInUSDC(paymentToken, provider)
                    .then(price => setCurrentPrice(price))
                    .catch(err => {
                        debugWarn('Failed to fetch token price:', err);
                        setCurrentPrice(null);
                    });
            } else {
                debugWarn('Invalid payment token:', paymentToken);
                setCurrentPrice(null);
            }
        }
    }, [auction, provider]);

    const loadAuction = async () => {
        try {
            setLoading(true);
            setAuction(null); // Clear existing auction
            
            debugLog(`🔍 Loading auction ${auctionId}...`);
            
            if (!auctionId || auctionId === 'undefined') {
                debugWarn('❌ Invalid auction ID provided');
                return;
            }

            if (!provider) {
                debugWarn('❌ No provider available for auction loading');
                return;
            }

            if (!marketplaceAddress) {
                debugWarn('❌ No marketplace address configured');
                return;
            }

            debugLog(`📋 Marketplace address: ${marketplaceAddress}`);

            // Load auction from database/cache first - try multiple ID formats
            const cachedAuctions = await getCachedAuctions(null, marketplaceAddress);
            debugLog(`📦 Found ${cachedAuctions.length} cached auctions`);
            
            // Try multiple ID matching strategies
            let auctionData = cachedAuctions.find(a => {
                const candidateIds = [
                    a.id?.toString(),
                    a.auctionId?.toString(),
                    a.auction_id?.toString()
                ].filter(id => id && id !== 'undefined' && id !== 'null');
                
                return candidateIds.some(id => id === auctionId.toString());
            });
            
            if (auctionData) {
                debugLog(`✅ Found auction in cache: ${auctionData.id || auctionData.auctionId}`);
                setAuction(auctionData);
                
                // Load current bid data
                const bids = await getAuctionBids(auctionId);
                setBids(bids);
                
                // Load NFT metadata if not already present
                if (!auctionData.metadata && auctionData.nftContract && auctionData.tokenId) {
                    loadNFTMetadata(auctionData.nftContract, auctionData.tokenId);
                }
            } else {
                debugLog('📡 Auction not found in cache, trying blockchain...');
                
                // Try loading from contract directly
                try {
                    const VTRUNFTMarketplaceABI = await import('../abi/VTRUNFTMarketplace.json');
                    const abi = VTRUNFTMarketplaceABI.default?.abi || VTRUNFTMarketplaceABI.abi;
                    if (!abi || !Array.isArray(abi)) {
                        throw new Error('Invalid ABI structure - ABI must be an array');
                    }
                    const marketplace = new ethers.Contract(marketplaceAddress, abi, provider);
                    
                    debugLog(`🔗 Calling marketplace.auctions(${auctionId})...`);
                    const auctionInfo = await marketplace.auctions(auctionId);
                    
                    debugLog('📋 Raw auction info from contract:', auctionInfo);
                    
                    if (auctionInfo && auctionInfo.seller && auctionInfo.seller !== ethers.ZeroAddress) {
                        const processedAuction = {
                            id: auctionId,
                            auctionId: auctionId,
                            seller: auctionInfo.seller,
                            nftContract: auctionInfo.nftContract,
                            tokenId: auctionInfo.tokenId.toString(),
                            startTime: Number(auctionInfo.startTime),
                            endTime: Number(auctionInfo.endTime),
                            startPrice: auctionInfo.startPrice?.toString() || auctionInfo.startingBid?.toString() || '0',
                            reservePrice: auctionInfo.reservePrice.toString(),
                            highestBid: auctionInfo.highestBid.toString(),
                            highestBidder: auctionInfo.highestBidder,
                            paymentToken: auctionInfo.paymentToken,
                            minBidIncrementBps: Number(auctionInfo.minBidIncrementBps || auctionInfo.minIncrementBps || 500),
                            antiSnipeSeconds: Number(auctionInfo.antiSnipeSeconds || auctionInfo.antiSnipeWindow || 300),
                            settled: auctionInfo.settled,
                            canceled: auctionInfo.canceled || false
                        };
                        
                        debugLog('✅ Successfully loaded auction from contract:', processedAuction);
                        setAuction(processedAuction);
                        loadNFTMetadata(processedAuction.nftContract, processedAuction.tokenId);
                    } else {
                        debugWarn('❌ Auction not found on contract or has zero address seller');
                        debugLog('🔍 Auction info details:', {
                            exists: !!auctionInfo,
                            seller: auctionInfo?.seller,
                            isZeroAddress: auctionInfo?.seller === ethers.ZeroAddress
                        });
                    }
                } catch (contractError) {
                    debugWarn('❌ Could not load auction from contract:', contractError);
                    criticalError('Contract loading failed:', contractError);
                }
            }
            
        } catch (error) {
            criticalError('❌ Error loading auction:', error);
        } finally {
            setLoading(false);
        }
    };

    const loadNFTMetadata = async (nftContract, tokenId) => {
        if (!nftContract || !tokenId || !provider) {
            debugWarn('Missing required parameters for metadata loading');
            return;
        }

        try {
            debugLog(`🎨 Loading enhanced metadata for ${nftContract}:${tokenId}`);
            
            // Use the robust metadata loader with existing auction metadata as a starting point
            const existingMetadata = auction?.metadata || nftMetadata;
            const metadata = await loadMetadata(nftContract, tokenId, provider, existingMetadata);
            
            debugLog(`✅ Enhanced metadata loaded successfully:`, metadata);
            
            setNftMetadata(metadata);
            // Also update the auction object with metadata for SmartMedia component
            setAuction(prev => ({
                ...prev,
                metadata: metadata
            }));

        } catch (error) {
            criticalError(`Error loading enhanced metadata for ${nftContract}:${tokenId}:`, error);
            
            // Set fallback metadata
            const fallbackMetadata = {
                name: `Token #${tokenId}`,
                description: `NFT Token #${tokenId}`,
                image: 'https://picsum.photos/seed/default/300/300',
                imageUrl: 'https://picsum.photos/seed/default/300/300',
                attributes: [],
                collection: null,
                contractAddress: nftContract,
                tokenId: tokenId,
                loaded: true,
                loading: false,
                error: error.message,
                timestamp: Date.now()
            };
            
            setNftMetadata(fallbackMetadata);
            setAuction(prev => ({
                ...prev,
                metadata: fallbackMetadata
            }));
        }
    };

    const handleBid = async () => {
        if (!wallet) {
            await connect();
            return;
        }

        if (!bidAmount || !auction) {
            alert('Please enter a bid amount');
            return;
        }

        try {
            setBidding(true);
            
            const VTRUNFTMarketplaceABI = await import('../abi/VTRUNFTMarketplace.json');
            const abi = VTRUNFTMarketplaceABI.default?.abi || VTRUNFTMarketplaceABI.abi;
            if (!abi || !Array.isArray(abi)) {
                throw new Error('Invalid ABI structure - ABI must be an array');
            }
            const marketplace = new ethers.Contract(marketplaceAddress, abi, signer);
            
            // Convert bid amount to wei
            const bidAmountWei = ethers.parseEther(bidAmount.toString());
            
            // Validate auction payment token - if it's native token (VTRU), send value
            const isNativeToken = !auction.paymentToken || 
                                auction.paymentToken === ethers.ZeroAddress || 
                                auction.paymentToken === '0x0000000000000000000000000000000000000000';
            
            debugLog(`🔨 Placing bid for auction ${auctionId} with amount ${bidAmount} VTRU`);
            debugLog(`💰 Payment token: ${auction.paymentToken}, isNative: ${isNativeToken}`);
            
            // Place bid with correct parameters - for native tokens, amount should be 0 and value contains the bid
            const tx = isNativeToken 
                ? await marketplace.bid(auctionId, 0, { value: bidAmountWei })
                : await marketplace.bid(auctionId, bidAmountWei);
            
            debugLog(`✅ Bid transaction submitted: ${tx.hash}`);
            await tx.wait();
            
            // Refresh auction data
            loadAuction();
            setBidAmount('');
            
        } catch (error) {
            criticalError('Error placing bid:', error);
            alert(`Error placing bid: ${error.message || 'Transaction failed'}`);
        } finally {
            setBidding(false);
        }
    };

    const handleSettle = async () => {
        if (!auction || !signer) {
            return;
        }

        try {
            setSettling(true);
            
            const VTRUNFTMarketplaceABI = await import('../abi/VTRUNFTMarketplace.json');
            const abi = VTRUNFTMarketplaceABI.default?.abi || VTRUNFTMarketplaceABI.abi;
            if (!abi || !Array.isArray(abi)) {
                throw new Error('Invalid ABI structure - ABI must be an array');
            }
            const marketplace = new ethers.Contract(marketplaceAddress, abi, signer);
            
            // Settle auction
            const tx = await marketplace.settleAuction(auctionId);
            await tx.wait();
            
            // Refresh auction data
            loadAuction();
            
        } catch (error) {
            criticalError('Error settling auction:', error);
            alert(`Error settling auction: ${error.message || 'Transaction failed'}`);
        } finally {
            setSettling(false);
        }
    };

    const formatTimeLeft = () => {
        if (timeLeft <= 0) return 'Auction ended';
        
        const days = Math.floor(timeLeft / 86400);
        const hours = Math.floor((timeLeft % 86400) / 3600);
        const minutes = Math.floor((timeLeft % 3600) / 60);
        const seconds = timeLeft % 60;

        if (days > 0) return `${days}d ${hours}h ${minutes}m`;
        if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
        if (minutes > 0) return `${minutes}m ${seconds}s`;
        return `${seconds}s`;
    };

    const getMinNextBid = () => {
        if (!auction) return '0';
        
        const currentBid = auction.highestBid === '0' ? 
            (auction.startPrice || auction.startingBid || '0') : 
            auction.highestBid;
        
        const incrementBps = auction.minBidIncrementBps || 500; // 5% default
        const increment = (BigInt(currentBid) * BigInt(incrementBps)) / BigInt(10000);
        return (BigInt(currentBid) + increment).toString();
    };

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

    if (loading) {
        return (
            <div className="sell-container">
                <div className="page-header">
                    <h1>Loading Auction...</h1>
                </div>
                <div className="sell-layout">
                    <div className="preview-loading">
                        <div className="loader"></div>
                        <p>Loading auction data...</p>
                    </div>
                </div>
            </div>
        );
    }

    if (!auction) {
        return (
            <div className="sell-container">
                <div className="page-header">
                    <h1>Auction Not Found</h1>
                    <p>The auction you're looking for doesn't exist or has been removed.</p>
                </div>
                <div className="sell-layout">
                    <div className="sell-form">
                        <button onClick={() => navigate('/marketplace')} className="secondary-button">
                            Back to Marketplace
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    const tokenInfo = getTokenInfo(auction.paymentToken);
    const isAuctionEnded = timeLeft <= 0;
    const hasReserveMet = BigInt(auction.highestBid) >= BigInt(auction.reservePrice);
    const minNextBid = getMinNextBid();

    const currentBidValue = auction.highestBid === '0' ? 
        (auction.startPrice || auction.startingBid || '0') : 
        auction.highestBid;
    const currentBidInToken = ethers.formatEther(currentBidValue);
    const currentBidInUSD = currentPrice ? (parseFloat(currentBidInToken) * currentPrice).toFixed(2) : 'Unknown';

    return (
        <div className="sell-container">
            <div className="page-header">
                <h1>{auction.metadata?.name || nftMetadata?.name || `Token #${auction.tokenId}`}</h1>
                <p>Auction #{auction.id}</p>
            </div>

            <div className="sell-layout">
                {/* NFT Display */}
                <div className="nft-preview">
                    <div className="premium-preview tilt-3d">
                        <div className="preview-header">
                            <div className="preview-badge">
                                {isAuctionEnded ? '⏰ Ended' : '🔨 Live Auction'}
                            </div>
                            {hasReserveMet && (
                                <div className="ownership-badge">
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="#22cc88">
                                        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                                    </svg>
                                    <span>Reserve Met</span>
                                </div>
                            )}
                        </div>

                        <div className="premium-image-container">
                            <div className="premium-image-wrapper">
                                <SmartMedia
                                    srcList={[
                                        auction.metadata?.image,
                                        auction.metadata?.image_url,
                                        auction.metadata?.imageUrl,
                                        auction.metadata?.animation_url,
                                        auction.metadata?.animationUrl,
                                        nftMetadata?.image,
                                        nftMetadata?.image_url,
                                        nftMetadata?.imageUrl,
                                        nftMetadata?.animation_url,
                                        nftMetadata?.animationUrl,
                                    ]}
                                    alt={auction.metadata?.name || nftMetadata?.name || `Token #${auction.tokenId}`}
                                    width={640}
                                    height={460}
                                    seed={`${auction.nftContract}-${auction.tokenId}`}
                                    title={auction.metadata?.name || nftMetadata?.name || `Token #${auction.tokenId}`}
                                    className="premium-image"
                                />
                                <div className="image-overlay">
                                    <a
                                        href={expandToCandidateUrls(auction.metadata?.image || nftMetadata?.image)[0] || auction.metadata?.image || nftMetadata?.image}
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
                            </div>
                        </div>

                        <div className="preview-title-section">
                            <h2 className="preview-name">{auction.metadata?.name || nftMetadata?.name || `Token #${auction.tokenId}`}</h2>
                            <div className="preview-contract">
                                <span className="contract-label">Contract:</span>
                                <span className="contract-address">{`${auction.nftContract.slice(0, 6)}...${auction.nftContract.slice(-4)}`}</span>
                                <span className="token-id">#{auction.tokenId}</span>
                            </div>
                        </div>

                        <div className="preview-tabs">
                            <button className={activeTab === 'details' ? 'active' : ''} onClick={() => setActiveTab('details')}>
                                Details
                            </button>
                            <button className={activeTab === 'properties' ? 'active' : ''} onClick={() => setActiveTab('properties')}>
                                Properties
                            </button>
                            <button className={activeTab === 'activity' ? 'active' : ''} onClick={() => setActiveTab('activity')}>
                                Activity
                            </button>
                        </div>

                        <div className="preview-tab-content">
                            {activeTab === 'details' && (
                                <div className="details-tab">
                                    <div className="preview-description">
                                        <h4>Description</h4>
                                        <p>{auction.metadata?.description || nftMetadata?.description || 'No description available'}</p>
                                    </div>

                                    <div className="preview-details">
                                        <div className="detail-row">
                                            <span className="detail-label">Contract</span>
                                            <span className="detail-value">
                                                <a href={`https://explorer.vitruveo.xyz/address/${auction.nftContract}`} target="_blank" rel="noopener noreferrer">
                                                    {`${auction.nftContract.slice(0, 6)}...${auction.nftContract.slice(-4)}`}
                                                </a>
                                            </span>
                                        </div>
                                        <div className="detail-row">
                                            <span className="detail-label">Token ID</span>
                                            <span className="detail-value">#{auction.tokenId}</span>
                                        </div>
                                        <div className="detail-row">
                                            <span className="detail-label">Seller</span>
                                            <span className="detail-value">
                                                {`${auction.seller.slice(0, 6)}...${auction.seller.slice(-4)}`}
                                            </span>
                                        </div>
                                        <div className="detail-row">
                                            <span className="detail-label">Auction Status</span>
                                            <span className="detail-value">
                                                {auction.settled ? 'Settled' : isAuctionEnded ? 'Ended' : 'Active'}
                                            </span>
                                        </div>
                                    </div>

                                    {isString(auction.metadata?.external_url || nftMetadata?.external_url) && (
                                        <div className="external-link">
                                            <h4>External Link</h4>
                                            <a href={auction.metadata?.external_url || nftMetadata?.external_url} target="_blank" rel="noopener noreferrer">
                                                {auction.metadata?.external_url || nftMetadata?.external_url}
                                            </a>
                                        </div>
                                    )}
                                </div>
                            )}

                            {activeTab === 'properties' && (
                                <div className="properties-tab">
                                    <h4>Properties</h4>
                                    {Array.isArray(auction.metadata?.attributes || nftMetadata?.attributes) && (auction.metadata?.attributes || nftMetadata?.attributes).length > 0 ? (
                                        <div className="attributes-grid">
                                            {(auction.metadata?.attributes || nftMetadata?.attributes).map((attr, index) => {
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

                            {activeTab === 'activity' && (
                                <div className="activity-tab">
                                    <h4>Auction Activity</h4>
                                    <div className="activity-feed">
                                        <div className="activity-item">
                                            <div className="activity-icon">🔨</div>
                                            <div className="activity-details">
                                                <div className="activity-title">Auction Started</div>
                                                <div className="activity-meta">Starting price: {ethers.formatEther(auction.startPrice || auction.startingBid || '0')} VTRU</div>
                                                <div className="activity-time">2 hours ago</div>
                                            </div>
                                        </div>
                                        
                                        {auction.highestBid !== '0' && (
                                            <div className="activity-item">
                                                <div className="activity-icon">💰</div>
                                                <div className="activity-details">
                                                    <div className="activity-title">Bid Placed</div>
                                                    <div className="activity-meta">
                                                        {ethers.formatEther(auction.highestBid)} VTRU by {auction.highestBidder.slice(0, 6)}...{auction.highestBidder.slice(-4)}
                                                    </div>
                                                    <div className="activity-time">1 hour ago</div>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Auction Info */}
                <div className="sell-form">
                    <div className="card glow-card">
                        <div className="auction-stats">
                            <div className="stat-item">
                                <label>Time Remaining</label>
                                <div className={`time-left ${isAuctionEnded ? 'ended' : ''}`}>
                                    {formatTimeLeft()}
                                </div>
                            </div>

                            <div className="stat-item">
                                <label>Current Bid</label>
                                <div className="current-bid">
                                    {currentBidInToken} {tokenInfo?.symbol || 'VTRU'}
                                    {currentBidInUSD !== 'Unknown' && (
                                        <div className="bid-usd">≈ ${currentBidInUSD} USD</div>
                                    )}
                                </div>
                            </div>

                            <div className="stat-item">
                                <label>Reserve Price</label>
                                <div className="reserve-price">
                                    {ethers.formatEther(auction.reservePrice)} {tokenInfo?.symbol || 'VTRU'}
                                    {hasReserveMet ? ' ✅' : ' ❌'}
                                </div>
                            </div>

                            {auction.highestBidder !== '0x0000000000000000000000000000000000000000' && (
                                <div className="stat-item">
                                    <label>Highest Bidder</label>
                                    <div className="highest-bidder">
                                        {auction.highestBidder.slice(0, 6)}...{auction.highestBidder.slice(-4)}
                                    </div>
                                </div>
                            )}
                        </div>

                        {!isAuctionEnded && !auction.settled && (
                            <div className="bid-section">
                                <div className="form-group">
                                    <label htmlFor="bidAmount">
                                        Your Bid (min: {ethers.formatEther(minNextBid.toString())} {tokenInfo?.symbol || 'VTRU'})
                                    </label>
                                    <input
                                        type="text"
                                        id="bidAmount"
                                        className="input"
                                        value={bidAmount}
                                        onChange={(e) => setBidAmount(e.target.value)}
                                        placeholder="Enter bid amount"
                                    />
                                </div>
                                <button 
                                    onClick={handleBid}
                                    className="primary-button"
                                    disabled={!bidAmount}
                                >
                                    {wallet ? 'Place Bid' : 'Connect Wallet to Bid'}
                                </button>
                            </div>
                        )}

                        {isAuctionEnded && !auction.settled && (
                            <div className="settle-section">
                                <h3>Auction Ended</h3>
                                <p>This auction has ended and needs to be settled.</p>
                                {hasReserveMet ? (
                                    <p>Reserve price was met. Winner will receive the NFT.</p>
                                ) : (
                                    <p>Reserve price was not met. NFT will be returned to seller.</p>
                                )}
                                <button 
                                    onClick={handleSettle}
                                    className="primary-button"
                                >
                                    Settle Auction
                                </button>
                            </div>
                        )}

                        {auction.settled && (
                            <div className="settled-section">
                                <h3>Auction Settled</h3>
                                {hasReserveMet ? (
                                    <p>Winner: {auction.highestBidder.slice(0, 6)}...{auction.highestBidder.slice(-4)}</p>
                                ) : (
                                    <p>Reserve price not met. NFT returned to seller.</p>
                                )}
                            </div>
                        )}

                        {status && (
                            <div className="status-message">
                                {status}
                            </div>
                        )}

                        <div className="auction-details-summary" style={{ marginTop: '2rem', padding: '1rem', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                            <h4>Auction Details</h4>
                            <div className="detail-row">
                                <span className="detail-label">Min Bid Increment</span>
                                <span className="detail-value">{(auction.minBidIncrementBps / 100).toFixed(1)}%</span>
                            </div>
                            <div className="detail-row">
                                <span className="detail-label">Anti-Snipe Extension</span>
                                <span className="detail-value">{Math.floor(auction.antiSnipeSeconds / 60)} minutes</span>
                            </div>
                            <div className="detail-row">
                                <span className="detail-label">Payment Token</span>
                                <span className="detail-value">{tokenInfo?.symbol || 'VTRU'}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default AuctionDetailPage;