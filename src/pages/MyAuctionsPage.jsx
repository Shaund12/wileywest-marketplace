import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { isAuctionsEnabled } from '../utils/featureFlags';
import { formatTokenAmount } from '../utils/tokenRegistry';

function MyAuctionsPage() {
    const navigate = useNavigate();
    const { wallet, connect } = useWallet();
    const { status } = useMarketplace();
    const [auctions, setAuctions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all'); // all, active, ended, settled

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
                                <img 
                                    src={auction.metadata?.image || 'https://picsum.photos/200/200'} 
                                    alt={auction.metadata?.name || `Token #${auction.tokenId}`}
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