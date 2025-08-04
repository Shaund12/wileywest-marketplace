import React, { useEffect } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import ListingCard from '../components/ListingCard';

function HotListingsPage() {
  const { hotListings, fetchListings } = useMarketplace();
  
  useEffect(() => {
    fetchListings();
  }, []);
  
  return (
    <div className="hot-listings-container">
      <div className="page-header">
        <h1>🔥 Hot Listings</h1>
        <p>The most popular NFTs in our marketplace right now</p>
      </div>
      
      <div className="listings-grid featured">
        {hotListings.length > 0 ? (
          hotListings.map(listing => (
            <ListingCard 
              key={listing.id} 
              listing={listing} 
              featured={true}
            />
          ))
        ) : (
          <div className="no-listings">
            <p>No hot listings available at the moment</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default HotListingsPage;