import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { useSupabase } from '../context/SupabaseContext';
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
    const { wallet, connect, signer, provider } = useWallet();
    const { status, marketplaceAddress } = useMarketplace();
    const { getCachedAuctions, getAuctionBids } = useSupabase();
    const [auctions, setAuctions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all'); // all, active, ended, settled
    const [auctionMetadata, setAuctionMetadata] = useState({});
    const [auctionBids, setAuctionBids] = useState({});
    const [loadingMetadata, setLoadingMetadata] = useState(new Set());
    const [actionStatus, setActionStatus] = useState('');

    // Set document title
    useEffect(() => {
        document.title = 'My Auctions • BlockDust';
    }, []);

    useEffect(() => {
        if (!wallet) {
            return;
        }

        loadUserAuctions();
    }, [wallet]);

    const loadUserAuctions = async () => {
        try {
            setLoading(true);
            setActionStatus('Loading your auctions...');
            
            // Load auctions from database for the connected wallet and current marketplace
            const userAuctions = await getCachedAuctions(wallet, marketplaceAddress);
            console.log(`📦 Loaded ${userAuctions.length} auctions for user ${wallet} on marketplace ${marketplaceAddress}`);
            
            // Load current bids for each auction and update auction data from contract if needed
            const auctionsWithCurrentData = await Promise.all(
                userAuctions.map(async (auction) => {
                    try {
                        // Ensure auction has valid ID
                        if (!auction.id || auction.id === 'undefined') {
                            console.warn('⚠️ Auction missing valid ID, skipping bid retrieval');
                            return auction;
                        }
                        
                        // Get latest bid data
                        const bids = await getAuctionBids(auction.id);
                        
                        // Update highest bid from bid history if available
                        if (bids.length > 0) {
                            const latestBid = bids[0]; // Already sorted by timestamp desc
                            auction.highestBid = latestBid.amount;
                            auction.highestBidder = latestBid.bidder;
                        }
                        
                        setAuctionBids(prev => ({
                            ...prev,
                            [auction.id]: bids
                        }));
                        
                        return auction;
                    } catch (error) {
                        console.warn(`Error loading bid data for auction ${auction.id}:`, error);
                        return auction;
                    }
                })
            );
            
            setAuctions(auctionsWithCurrentData);
            setActionStatus('');
            
            // Load NFT metadata for each auction
            loadAuctionMetadata(auctionsWithCurrentData);
            
        } catch (error) {
            console.error('Error loading user auctions:', error);
            setActionStatus('Failed to load auctions');
            setAuctions([]);
        } finally {
            setLoading(false);
        }
    };

    const loadAuctionMetadata = async (auctionsList) => {
        for (const auction of auctionsList) {
            const key = `${auction.nftContract}-${auction.tokenId}`;
            
            if (auctionMetadata[key] || loadingMetadata.has(key)) {
                continue; // Skip if already loaded or loading
            }
            
            setLoadingMetadata(prev => new Set(prev).add(key));
            
            try {
                // Fetch NFT metadata from contract
                if (provider && auction.nftContract && auction.nftContract !== '0x0000000000000000000000000000000000000000') {
                    const nftContract = new ethers.Contract(
                        auction.nftContract,
                        [
                            'function tokenURI(uint256) view returns (string)',
                            'function uri(uint256) view returns (string)', // ERC1155
                            'function name() view returns (string)',
                            'function symbol() view returns (string)'
                        ],
                        provider
                    );

                    let tokenURI = '';
                    try {
                        // Ensure tokenId is valid
                        const tokenId = auction.tokenId || '0';
                        tokenURI = await nftContract.tokenURI(tokenId);
                    } catch {
                        try {
                            const tokenId = auction.tokenId || '0';
                            tokenURI = await nftContract.uri(tokenId);
                        } catch {
                            console.warn(`Could not get tokenURI for ${auction.nftContract}:${auction.tokenId}`);
                        }
                    }

                    let metadata = {};
                    if (tokenURI) {
                        try {
                            // Handle IPFS URIs
                            let metadataUrl = tokenURI;
                            if (tokenURI.startsWith('ipfs://')) {
                                metadataUrl = `https://cloudflare-ipfs.com/ipfs/${tokenURI.replace('ipfs://', '')}`;
                            }

                            const response = await fetch(metadataUrl);
                            if (response.ok) {
                                metadata = await response.json();
                            }
                        } catch (error) {
                            console.warn(`Error fetching metadata from ${tokenURI}:`, error);
                        }
                    }

                    // Try to get collection name
                    try {
                        const name = await nftContract.name();
                        const symbol = await nftContract.symbol();
                        metadata.collection = { name, symbol };
                    } catch (error) {
                        console.warn(`Error fetching collection info:`, error);
                    }

                    setAuctionMetadata(prev => ({
                        ...prev,
                        [key]: metadata
                    }));
                }
            } catch (error) {
                console.warn(`Error loading metadata for auction ${auction.id}:`, error);
            } finally {
                setLoadingMetadata(prev => {
                    const newSet = new Set(prev);
                    newSet.delete(key);
                    return newSet;
                });
            }
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

    const handleCancelAuction = async (auction) => {
        if (!signer) {
            setActionStatus('Please connect your wallet');
            return;
        }

        try {
            setActionStatus('Canceling auction...');

            // Import marketplace ABI and create contract instance
            const VTRUNFTMarketplaceABI = await import('../abi/VTRUNFTMarketplace.json');
            const marketplaceContract = new ethers.Contract(marketplaceAddress, VTRUNFTMarketplaceABI.default, signer);

            // Cancel the auction
            const tx = await marketplaceContract.cancelAuction(auction.id);
            setActionStatus('Transaction submitted. Waiting for confirmation...');
            
            await tx.wait();
            setActionStatus('Auction canceled successfully!');
            
            // Refresh auctions list
            setTimeout(() => {
                loadUserAuctions();
                setActionStatus('');
            }, 2000);
            
        } catch (error) {
            console.error('Error canceling auction:', error);
            setActionStatus(`Error: ${error.message || 'Could not cancel auction'}`);
            setTimeout(() => setActionStatus(''), 5000);
        }
    };

    const handleSettleAuction = async (auction) => {
        if (!signer) {
            setActionStatus('Please connect your wallet');
            return;
        }

        try {
            setActionStatus('Settling auction...');

            // Import marketplace ABI and create contract instance
            const VTRUNFTMarketplaceABI = await import('../abi/VTRUNFTMarketplace.json');
            const marketplaceContract = new ethers.Contract(marketplaceAddress, VTRUNFTMarketplaceABI.default, signer);

            // Settle the auction
            const tx = await marketplaceContract.settleAuction(auction.id);
            setActionStatus('Transaction submitted. Waiting for confirmation...');
            
            await tx.wait();
            setActionStatus('Auction settled successfully!');
            
            // Refresh auctions list
            setTimeout(() => {
                loadUserAuctions();
                setActionStatus('');
            }, 2000);
            
        } catch (error) {
            console.error('Error settling auction:', error);
            setActionStatus(`Error: ${error.message || 'Could not settle auction'}`);
            setTimeout(() => setActionStatus(''), 5000);
        }
    };

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
                    {filteredAuctions.map(auction => {
                        const metadataKey = `${auction.nftContract}-${auction.tokenId}`;
                        const metadata = auctionMetadata[metadataKey] || {};
                        const bids = auctionBids[auction.id] || [];
                        const auctionStatus = getAuctionStatus(auction);
                        const isActive = auctionStatus === 'Active';
                        const isEnded = auctionStatus === 'Ended';
                        const canCancel = isActive && auction.highestBid === '0';
                        const canSettle = isEnded && !auction.settled;
                        
                        return (
                            <div key={auction.id} className="auction-card">
                                <div className="auction-image">
                                    <SmartMedia
                                        srcList={[
                                            metadata?.image,
                                            metadata?.image_url,
                                            metadata?.imageUrl,
                                            metadata?.animation_url,
                                            metadata?.animationUrl,
                                        ]}
                                        alt={metadata?.name || `Token #${auction.tokenId}`}
                                        width={200}
                                        height={200}
                                        seed={`${auction.nftContract}-${auction.tokenId}`}
                                        title={metadata?.name || `Token #${auction.tokenId}`}
                                    />
                                    <div className={`status-badge ${auctionStatus.toLowerCase()}`}>
                                        {auctionStatus}
                                    </div>
                                </div>

                                <div className="auction-details">
                                    <h4>{metadata?.name || `Token #${auction.tokenId}`}</h4>
                                    {metadata?.collection && (
                                        <p className="collection-name">{metadata.collection.name}</p>
                                    )}
                                    
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

                                        {bids.length > 0 && (
                                            <div className="stat">
                                                <label>Total Bids</label>
                                                <span>{bids.length}</span>
                                            </div>
                                        )}
                                    </div>

                                    <div className="auction-actions">
                                        <button 
                                            onClick={() => navigate(`/auctions/${auction.id}`)}
                                            className="hp-btn"
                                        >
                                            View Details
                                        </button>
                                        
                                        {canCancel && (
                                            <button 
                                                onClick={() => handleCancelAuction(auction)}
                                                className="hp-btn hp-btn--danger"
                                                disabled={!!actionStatus}
                                            >
                                                Cancel
                                            </button>
                                        )}

                                        {canSettle && (
                                            <button 
                                                onClick={() => handleSettleAuction(auction)}
                                                className="hp-btn hp-btn--success"
                                                disabled={!!actionStatus}
                                            >
                                                Settle
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {(status || actionStatus) && (
                <div className="status-message">
                    {actionStatus || status}
                </div>
            )}

            <style jsx>{`
                .auctions-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
                    gap: 1.5rem;
                    margin-top: 2rem;
                }

                .auction-card {
                    background: #1a1a1a;
                    border: 1px solid #333;
                    border-radius: 8px;
                    overflow: hidden;
                    transition: transform 0.2s ease;
                }

                .auction-card:hover {
                    transform: translateY(-2px);
                    border-color: #555;
                }

                .auction-image {
                    position: relative;
                    width: 100%;
                    height: 200px;
                    overflow: hidden;
                }

                .status-badge {
                    position: absolute;
                    top: 8px;
                    right: 8px;
                    padding: 4px 8px;
                    border-radius: 4px;
                    font-size: 12px;
                    font-weight: 600;
                    text-transform: uppercase;
                }

                .status-badge.active {
                    background: #16a34a;
                    color: white;
                }

                .status-badge.ended {
                    background: #dc2626;
                    color: white;
                }

                .status-badge.settled {
                    background: #6b7280;
                    color: white;
                }

                .auction-details {
                    padding: 1rem;
                }

                .auction-details h4 {
                    margin: 0 0 0.5rem 0;
                    color: #f1f5f9;
                    font-size: 1.1rem;
                }

                .collection-name {
                    margin: 0 0 1rem 0;
                    color: #94a3b8;
                    font-size: 0.875rem;
                }

                .auction-stats {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 0.75rem;
                    margin-bottom: 1rem;
                }

                .auction-stats .stat {
                    text-align: center;
                }

                .auction-stats .stat label {
                    display: block;
                    color: #94a3b8;
                    font-size: 0.75rem;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 0.25rem;
                }

                .auction-stats .stat span {
                    display: block;
                    color: #f1f5f9;
                    font-weight: 600;
                    font-size: 0.875rem;
                }

                .auction-actions {
                    display: flex;
                    gap: 0.5rem;
                    justify-content: space-between;
                }

                .auction-actions .hp-btn {
                    flex: 1;
                    padding: 0.5rem 1rem;
                    font-size: 0.875rem;
                }

                .auction-controls {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 2rem;
                    flex-wrap: wrap;
                    gap: 1rem;
                }

                .filter-tabs {
                    display: flex;
                    gap: 0.5rem;
                }

                .filter-tabs button {
                    padding: 0.5rem 1rem;
                    background: #2a2a2a;
                    border: 1px solid #444;
                    color: #94a3b8;
                    border-radius: 6px;
                    cursor: pointer;
                    transition: all 0.2s ease;
                    font-size: 0.875rem;
                }

                .filter-tabs button:hover {
                    background: #333;
                    border-color: #555;
                }

                .filter-tabs button.active {
                    background: #3b82f6;
                    border-color: #3b82f6;
                    color: white;
                }

                .loading-message,
                .empty-state {
                    text-align: center;
                    padding: 3rem 1rem;
                    color: #94a3b8;
                }

                .empty-state h3 {
                    color: #f1f5f9;
                    margin-bottom: 0.5rem;
                }

                .status-message {
                    margin-top: 1rem;
                    padding: 0.75rem;
                    background: #1e293b;
                    border: 1px solid #334155;
                    border-radius: 6px;
                    color: #94a3b8;
                    text-align: center;
                }

                .hp-btn--success {
                    background: #16a34a;
                    border-color: #16a34a;
                    color: white;
                }

                .hp-btn--success:hover {
                    background: #15803d;
                    border-color: #15803d;
                }

                .hp-btn--danger {
                    background: #dc2626;
                    border-color: #dc2626;
                    color: white;
                }

                .hp-btn--danger:hover {
                    background: #b91c1c;
                    border-color: #b91c1c;
                }
            `}</style>
        </div>
    );
}

export default MyAuctionsPage;