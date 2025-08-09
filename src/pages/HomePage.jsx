import React from 'react';
import { Link } from 'react-router-dom';
import { useMarketplace } from '../context/MarketplaceContext';
import ListingCard from '../components/ListingCard';
import CacheStats from '../components/CacheStats';

function HomePage() {
    const { hotListings } = useMarketplace();

    return (
        <div className="home-container">
            <div className="hero-section">
                <h1>WileyW€$T NFT Marketplace</h1>
                <p className="subtitle">Trade in the neon shadows. Own the future.</p>
                <div className="hero-buttons">
                    <Link to="/marketplace" className="primary-button">Explore NFTs</Link>
                    <Link to="/sell" className="secondary-button">Sell Your NFT</Link>
                </div>
            </div>

            <div className="featured-section">
                <div className="section-header">
                    <h2>Featured Listings</h2>
                    <Link to="/hot-listings" className="view-all">View All</Link>
                </div>

                <div className="listings-preview">
                    {hotListings.slice(0, 3).map(listing => (
                        <ListingCard key={listing.id} listing={listing} featured={true} />
                    ))}
                </div>
            </div>

            <div className="how-it-works">
                <h2>How It Works</h2>
                <div className="steps">
                    <div className="step">
                        <div className="step-number">1</div>
                        <h3>Connect Wallet</h3>
                        <p>Link your cryptocurrency wallet to get started</p>
                    </div>
                    <div className="step">
                        <div className="step-number">2</div>
                        <h3>Browse NFTs</h3>
                        <p>Explore our curated collection of digital assets</p>
                    </div>
                    <div className="step">
                        <div className="step-number">3</div>
                        <h3>Buy or Sell</h3>
                        <p>Trade NFTs securely on our decentralized marketplace</p>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default HomePage;