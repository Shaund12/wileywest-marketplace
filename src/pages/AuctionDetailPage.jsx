import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { canPerformAuctionAction, isAuctionsEnabled } from '../utils/featureFlags';
import { formatTokenAmount, getTokenInfo } from '../utils/tokenRegistry';

function AuctionDetailPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { wallet, connect } = useWallet();
    const { status } = useMarketplace();
    const [auction, setAuction] = useState(null);
    const [loading, setLoading] = useState(true);
    const [bidAmount, setBidAmount] = useState('');
    const [timeLeft, setTimeLeft] = useState(0);

    useEffect(() => {
        if (!isAuctionsEnabled()) {
            navigate('/marketplace');
            return;
        }

        // TODO: Load auction data
        loadAuction();
    }, [id, navigate]);

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

    const loadAuction = async () => {
        try {
            setLoading(true);
            // TODO: Implement auction loading from contract
            
            // Mock data for now
            setAuction({
                id: id,
                seller: '0x1234567890123456789012345678901234567890',
                nftContract: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
                tokenId: '1',
                quantity: '1',
                reservePrice: '1000000000000000000', // 1 VTRU
                startPrice: '100000000000000000', // 0.1 VTRU
                endTime: Math.floor(Date.now() / 1000) + 86400, // 24 hours
                paymentToken: '0x0000000000000000000000000000000000000000',
                minBidIncrementBps: 500,
                antiSnipeSeconds: 600,
                highestBidder: '0x0000000000000000000000000000000000000000',
                highestBid: '0',
                settled: false,
                metadata: {
                    name: 'Cosmic Dream #1',
                    description: 'A beautiful cosmic-themed digital artwork',
                    image: 'https://picsum.photos/seed/auction1/400/400'
                }
            });
        } catch (error) {
            console.error('Error loading auction:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleBid = async () => {
        if (!wallet) {
            await connect();
            return;
        }

        if (!bidAmount) {
            alert('Please enter a bid amount');
            return;
        }

        // TODO: Implement bidding
        console.log('Placing bid:', bidAmount);
    };

    const handleSettle = async () => {
        if (!canPerformAuctionAction(wallet, 'settle')) {
            alert('You are not allowed to settle auctions');
            return;
        }

        // TODO: Implement auction settlement
        console.log('Settling auction:', id);
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
        
        const currentBid = auction.highestBid === '0' ? auction.startPrice : auction.highestBid;
        const increment = (BigInt(currentBid) * BigInt(auction.minBidIncrementBps)) / BigInt(10000);
        return BigInt(currentBid) + increment;
    };

    if (!isAuctionsEnabled()) {
        return null;
    }

    if (loading) {
        return (
            <div className="hp" style={{ maxWidth: 1000, margin: '3rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head">
                    <h2>Loading Auction...</h2>
                </div>
            </div>
        );
    }

    if (!auction) {
        return (
            <div className="hp" style={{ maxWidth: 1000, margin: '3rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head">
                    <h2>Auction Not Found</h2>
                    <p>The auction you're looking for doesn't exist or has been removed.</p>
                </div>
                <button onClick={() => navigate('/marketplace')} className="hp-btn">
                    Back to Marketplace
                </button>
            </div>
        );
    }

    const tokenInfo = getTokenInfo(auction.paymentToken);
    const isAuctionEnded = timeLeft <= 0;
    const hasReserveMet = BigInt(auction.highestBid) >= BigInt(auction.reservePrice);
    const minNextBid = getMinNextBid();

    return (
        <div className="hp" style={{ maxWidth: 1000, margin: '3rem auto', padding: '0 1.25rem' }}>
            <div className="auction-detail">
                <div className="auction-content">
                    <div className="auction-image">
                        <img 
                            src={auction.metadata?.image || 'https://picsum.photos/400/400'} 
                            alt={auction.metadata?.name || `Token #${auction.tokenId}`}
                            style={{ width: '100%', borderRadius: '12px' }}
                        />
                    </div>

                    <div className="auction-info">
                        <div className="hp-section__head">
                            <h2>{auction.metadata?.name || `Token #${auction.tokenId}`}</h2>
                            <p>{auction.metadata?.description}</p>
                        </div>

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
                                    {auction.highestBid === '0' 
                                        ? formatTokenAmount(auction.startPrice, auction.paymentToken)
                                        : formatTokenAmount(auction.highestBid, auction.paymentToken)
                                    }
                                </div>
                            </div>

                            <div className="stat-item">
                                <label>Reserve Price</label>
                                <div className="reserve-price">
                                    {formatTokenAmount(auction.reservePrice, auction.paymentToken)}
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
                                        Your Bid (min: {formatTokenAmount(minNextBid.toString(), auction.paymentToken)})
                                    </label>
                                    <input
                                        type="text"
                                        id="bidAmount"
                                        value={bidAmount}
                                        onChange={(e) => setBidAmount(e.target.value)}
                                        placeholder="Enter bid amount"
                                    />
                                </div>
                                <button 
                                    onClick={handleBid}
                                    className="hp-btn hp-btn--primary"
                                    disabled={!bidAmount}
                                >
                                    {wallet ? 'Place Bid' : 'Connect Wallet to Bid'}
                                </button>
                            </div>
                        )}

                        {isAuctionEnded && !auction.settled && (
                            <div className="settle-section">
                                <p>This auction has ended and needs to be settled.</p>
                                {hasReserveMet ? (
                                    <p>Reserve price was met. Winner will receive the NFT.</p>
                                ) : (
                                    <p>Reserve price was not met. NFT will be returned to seller.</p>
                                )}
                                <button 
                                    onClick={handleSettle}
                                    className="hp-btn hp-btn--primary"
                                    disabled={!canPerformAuctionAction(wallet, 'settle')}
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
                    </div>
                </div>
            </div>
        </div>
    );
}

export default AuctionDetailPage;