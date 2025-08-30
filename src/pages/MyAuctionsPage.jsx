import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { isAuctionsEnabled } from '../utils/featureFlags';
import { formatTokenAmount } from '../utils/tokenRegistry';

/* =========================================================
   SmartMedia utilities (simplified version for auctions)
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

const isString = (v) => typeof v === 'string' && v.trim().length > 0;
const uniq = (arr) => Array.from(new Set(arr));
const flatten = (arrs) => arrs.reduce((a, b) => a.concat(b), []);
const isVideoUrl = (u) => isString(u) && /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(u);

function expandToCandidateUrls(raw) {
    if (!isString(raw)) return [];
    const url = raw.trim();
    if (url.startsWith('data:')) return [url];

    if (url.startsWith('ar://')) return [`https://arweave.net/${url.slice(5)}`];
    if (/^https?:\/\/arweave\.net\//i.test(url)) return [url];

    if (url.startsWith('ipfs://')) {
        const rest = url.slice(7).replace(/^ipfs\//i, '');
        return IPFS_GATEWAYS.map((g) => g + rest);
    }

    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const ipfsIdx = parts.indexOf('ipfs');
        if (ipfsIdx !== -1 && parts[ipfsIdx + 1]) {
            const rest = parts.slice(ipfsIdx + 1).join('/');
            return IPFS_GATEWAYS.map((g) => g + rest);
        }
        return [url];
    } catch {
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

function svgFallbackDataUrl({ seed = 'media', width = 200, height = 200, title = 'NFT Preview' }) {
    const h = hashString(seed);
    const hue = h % 360;
    const hue2 = (hue + 180) % 360;
    const gid = `g${(h % 1e9).toString(36)}`;
    const blobs = (h % 7) + 3;
    const label = (title || '').slice(0, 20) || 'NFT Preview';
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
        const r = 12 + ((h >> i) % 28);
        const cx = (width / (blobs + 1)) * (i + 1);
        const cy = (height / (blobs + 1)) * ((i % 3) + 1);
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsla(${a},70%,60%,0.25)"/>`;
    }).join('')}
  <text x="50%" y="${height - 12}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" font-size="12" fill="rgba(255,255,255,0.9)" text-anchor="middle">${label}</text>
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const smartUrlCache = new Map();
function SmartMedia({ srcList = [], alt = '', width = 200, height = 200, seed = 'media', title = '', className = '' }) {
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
                style={{ display: 'block', borderRadius: 8, background: '#111', maxWidth: '100%', objectFit: 'cover' }}
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
            style={{ display: 'block', borderRadius: 8, maxWidth: '100%', objectFit: 'cover' }}
        />
    );
}

function MyAuctionsPage() {
    const navigate = useNavigate();
    const { wallet, connect } = useWallet();
    const { status } = useMarketplace();
    const [auctions, setAuctions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all'); // all, active, ended, settled

    // Set document title
    useEffect(() => {
        document.title = 'My Auctions • BlockDust';
    }, []);

    useEffect(() => {
        if (!isAuctionsEnabled()) {
            navigate('/marketplace');
            return;
        }

        if (!wallet) {
            navigate('/?connect=true');
            return;
        }

        loadUserAuctions();
    }, [wallet, navigate]);

    const loadUserAuctions = async () => {
        try {
            setLoading(true);
            // TODO: Load user's auctions from contract
            
            // Mock data for now
            setAuctions([
                {
                    id: '1',
                    seller: wallet,
                    nftContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
                    tokenId: '1',
                    quantity: '1',
                    reservePrice: '1000000000000000000',
                    startPrice: '100000000000000000',
                    endTime: Math.floor(Date.now() / 1000) + 86400,
                    paymentToken: '0x0000000000000000000000000000000000000000',
                    highestBidder: '0x1111111111111111111111111111111111111111',
                    highestBid: '1500000000000000000',
                    settled: false,
                    metadata: {
                        name: 'Cosmic Dream #1',
                        image: 'https://picsum.photos/seed/auction1/200/200'
                    }
                },
                {
                    id: '2',
                    seller: wallet,
                    nftContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
                    tokenId: '2',
                    quantity: '1',
                    reservePrice: '2000000000000000000',
                    startPrice: '500000000000000000',
                    endTime: Math.floor(Date.now() / 1000) - 3600, // ended 1 hour ago
                    paymentToken: '0x0000000000000000000000000000000000000000',
                    highestBidder: '0x0000000000000000000000000000000000000000',
                    highestBid: '0',
                    settled: false,
                    metadata: {
                        name: 'Digital Warrior #5',
                        image: 'https://picsum.photos/seed/auction2/200/200'
                    }
                }
            ]);
        } catch (error) {
            console.error('Error loading user auctions:', error);
        } finally {
            setLoading(false);
        }
    };

    const filteredAuctions = auctions.filter(auction => {
        const now = Math.floor(Date.now() / 1000);
        const isActive = auction.endTime > now && !auction.settled;
        const isEnded = auction.endTime <= now && !auction.settled;
        const isSettled = auction.settled;

        switch (filter) {
            case 'active': return isActive;
            case 'ended': return isEnded;
            case 'settled': return isSettled;
            default: return true;
        }
    });

    const getAuctionStatus = (auction) => {
        const now = Math.floor(Date.now() / 1000);
        if (auction.settled) return 'Settled';
        if (auction.endTime <= now) return 'Ended';
        return 'Active';
    };

    const getTimeDisplay = (auction) => {
        const now = Math.floor(Date.now() / 1000);
        const diff = auction.endTime - now;
        
        if (auction.settled) return 'Settled';
        if (diff <= 0) return 'Ended';
        
        const days = Math.floor(diff / 86400);
        const hours = Math.floor((diff % 86400) / 3600);
        const minutes = Math.floor((diff % 3600) / 60);
        
        if (days > 0) return `${days}d ${hours}h left`;
        if (hours > 0) return `${hours}h ${minutes}m left`;
        return `${minutes}m left`;
    };

    if (!isAuctionsEnabled()) {
        return null;
    }

    if (!wallet) {
        return (
            <div className="hp" style={{ maxWidth: 800, margin: '3rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head">
                    <h2>My Auctions</h2>
                    <p>Connect your wallet to view your auctions</p>
                </div>
                <button onClick={connect} className="hp-btn hp-btn--primary">
                    Connect Wallet
                </button>
            </div>
        );
    }

    return (
        <div className="hp" style={{ maxWidth: 1200, margin: '3rem auto', padding: '0 1.25rem' }}>
            <div className="hp-section__head">
                <h2>My Auctions</h2>
                <p>Manage your auction listings</p>
            </div>

            <div className="auction-controls">
                <div className="filter-tabs">
                    <button 
                        className={filter === 'all' ? 'active' : ''}
                        onClick={() => setFilter('all')}
                    >
                        All ({auctions.length})
                    </button>
                    <button 
                        className={filter === 'active' ? 'active' : ''}
                        onClick={() => setFilter('active')}
                    >
                        Active ({auctions.filter(a => Math.floor(Date.now() / 1000) < a.endTime && !a.settled).length})
                    </button>
                    <button 
                        className={filter === 'ended' ? 'active' : ''}
                        onClick={() => setFilter('ended')}
                    >
                        Ended ({auctions.filter(a => Math.floor(Date.now() / 1000) >= a.endTime && !a.settled).length})
                    </button>
                    <button 
                        className={filter === 'settled' ? 'active' : ''}
                        onClick={() => setFilter('settled')}
                    >
                        Settled ({auctions.filter(a => a.settled).length})
                    </button>
                </div>

                <button 
                    onClick={() => navigate('/auctions/create')}
                    className="hp-btn hp-btn--primary"
                >
                    Create New Auction
                </button>
            </div>

            {loading ? (
                <div className="loading-message">
                    <p>Loading your auctions...</p>
                </div>
            ) : filteredAuctions.length === 0 ? (
                <div className="empty-state">
                    <h3>No auctions found</h3>
                    <p>
                        {filter === 'all' 
                            ? "You haven't created any auctions yet."
                            : `No ${filter} auctions found.`
                        }
                    </p>
                    <button 
                        onClick={() => navigate('/auctions/create')}
                        className="hp-btn hp-btn--primary"
                    >
                        Create Your First Auction
                    </button>
                </div>
            ) : (
                <div className="auctions-grid">
                    {filteredAuctions.map(auction => (
                        <div key={auction.id} className="auction-card">
                            <div className="auction-image">
                                <SmartMedia
                                    srcList={[
                                        auction.metadata?.image,
                                        auction.metadata?.image_url,
                                        auction.metadata?.imageUrl,
                                        auction.metadata?.animation_url,
                                        auction.metadata?.animationUrl,
                                    ]}
                                    alt={auction.metadata?.name || `Token #${auction.tokenId}`}
                                    width={200}
                                    height={200}
                                    seed={`${auction.nftContract}-${auction.tokenId}`}
                                    title={auction.metadata?.name || `Token #${auction.tokenId}`}
                                />
                                <div className={`status-badge ${getAuctionStatus(auction).toLowerCase()}`}>
                                    {getAuctionStatus(auction)}
                                </div>
                            </div>

                            <div className="auction-details">
                                <h4>{auction.metadata?.name || `Token #${auction.tokenId}`}</h4>
                                
                                <div className="auction-stats">
                                    <div className="stat">
                                        <label>Current Bid</label>
                                        <span>
                                            {auction.highestBid === '0' 
                                                ? formatTokenAmount(auction.startPrice, auction.paymentToken)
                                                : formatTokenAmount(auction.highestBid, auction.paymentToken)
                                            }
                                        </span>
                                    </div>
                                    
                                    <div className="stat">
                                        <label>Reserve</label>
                                        <span>{formatTokenAmount(auction.reservePrice, auction.paymentToken)}</span>
                                    </div>
                                    
                                    <div className="stat">
                                        <label>Time</label>
                                        <span>{getTimeDisplay(auction)}</span>
                                    </div>
                                </div>

                                <div className="auction-actions">
                                    <button 
                                        onClick={() => navigate(`/auctions/${auction.id}`)}
                                        className="hp-btn"
                                    >
                                        View Details
                                    </button>
                                    
                                    {getAuctionStatus(auction) === 'Active' && auction.highestBid === '0' && (
                                        <button 
                                            onClick={() => {
                                                // TODO: Implement cancel auction
                                                console.log('Cancel auction:', auction.id);
                                            }}
                                            className="hp-btn hp-btn--danger"
                                        >
                                            Cancel
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            )}

            {status && (
                <div className="status-message">
                    {status}
                </div>
            )}
        </div>
    );
}

export default MyAuctionsPage;