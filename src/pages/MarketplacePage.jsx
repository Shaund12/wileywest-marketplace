import React, { useEffect } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import ListingCard from '../components/ListingCard';

function MarketplacePage() {
    const { listings, fetchListings, status } = useMarketplace();

    useEffect(() => {
        fetchListings();
    }, []);

    return (
        <div className="marketplace-container">
            <div className="page-header">
                <h1>NFT Marketplace</h1>
                <p>Browse and collect unique digital assets</p>
            </div>

            <div className="marketplace-actions">
                <button className="secondary-button" onClick={fetchListings}>
                    Refresh Listings
                </button>
                <div className="status-indicator">
                    {status && <span>{status}</span>}
                </div>
            </div>

            <div className="listings-grid">
                {listings.length > 0 ? (
                    listings.map(listing => (
                        <ListingCard key={listing.id} listing={listing} />
                    ))
                ) : (
                    <div className="no-listings">
                        <p>No active listings found</p>
                    </div>
                )}
            </div>
        </div>
    );
}

export default MarketplacePage;