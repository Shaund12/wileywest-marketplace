import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { canPerformAuctionAction } from '../utils/featureFlags';
import { getSupportedTokens, formatTokenAmount } from '../utils/tokenRegistry';

function CreateAuctionPage() {
    const navigate = useNavigate();
    const { wallet, connect } = useWallet();
    const { status } = useMarketplace();
    const [formData, setFormData] = useState({
        nftContract: '',
        tokenId: '',
        quantity: '1',
        reservePrice: '',
        startPrice: '',
        duration: '24', // hours
        paymentToken: '0x0000000000000000000000000000000000000000', // Native VTRU
        minBidIncrementBps: '500', // 5%
        antiSnipeSeconds: '600', // 10 minutes
    });

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

    const handleSubmit = async (e) => {
        e.preventDefault();
        
        if (!wallet) {
            await connect();
            return;
        }

        // TODO: Implement auction creation
        console.log('Creating auction with data:', formData);
    };

    const handleInputChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: value
        }));
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

            <form onSubmit={handleSubmit} className="create-auction-form">
                <div className="form-group">
                    <label htmlFor="nftContract">NFT Contract Address</label>
                    <input
                        type="text"
                        id="nftContract"
                        name="nftContract"
                        value={formData.nftContract}
                        onChange={handleInputChange}
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
                        onChange={handleInputChange}
                        placeholder="1"
                        required
                    />
                </div>

                <div className="form-group">
                    <label htmlFor="quantity">Quantity (for ERC1155)</label>
                    <input
                        type="number"
                        id="quantity"
                        name="quantity"
                        min="1"
                        value={formData.quantity}
                        onChange={handleInputChange}
                        required
                    />
                </div>

                <div className="form-group">
                    <label htmlFor="paymentToken">Payment Token</label>
                    <select
                        id="paymentToken"
                        name="paymentToken"
                        value={formData.paymentToken}
                        onChange={handleInputChange}
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
                            onChange={handleInputChange}
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
                            onChange={handleInputChange}
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
                            onChange={handleInputChange}
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
                            onChange={handleInputChange}
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
                        onChange={handleInputChange}
                        required
                    >
                        <option value="300">5 minutes</option>
                        <option value="600">10 minutes</option>
                        <option value="900">15 minutes</option>
                        <option value="1800">30 minutes</option>
                    </select>
                    <small>Auction will extend by this duration if a bid is placed near the end</small>
                </div>

                {status && (
                    <div className="status-message">
                        {status}
                    </div>
                )}

                <div className="form-actions">
                    <button type="submit" className="hp-btn hp-btn--primary" disabled={!wallet}>
                        Create Auction
                    </button>
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