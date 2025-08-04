import React from 'react';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';

function ListingCard({ listing, featured = false, showSeller = true }) {
  const { buyListing, status } = useMarketplace();
  const { wallet, connect } = useWallet();
  
  const handleBuy = async () => {
    if (!wallet) {
      await connect();
      return;
    }
    
    buyListing(listing.id, listing.pricePerUnit, listing.paymentToken);
  };
  
  const isOwner = wallet && listing.seller.toLowerCase() === wallet.toLowerCase();
  
  // Generate a placeholder image based on the NFT contract and token ID
  const imageUrl = `https://picsum.photos/seed/${listing.nftContract}${listing.tokenId}/300/300`;
  
  return (
    <div className={`listing-card ${featured ? 'featured' : ''}`}>
      <div className="listing-image">
        <img src={imageUrl} alt={`NFT #${listing.tokenId}`} />
      </div>
      
      <div className="listing-details">
        <div className="listing-info">
          <h3>NFT #{listing.tokenId.toString()}</h3>
          <div className="listing-contract small">{listing.nftContract.slice(0, 6)}...{listing.nftContract.slice(-4)}</div>
        </div>
        
        <div className="listing-price">
          <div className="price-amount">
            {ethers.formatUnits(listing.pricePerUnit.toString(), 18)}
          </div>
          <div className="price-currency">
            {listing.paymentToken === ethers.ZeroAddress ? 'VTRU' : 'TOKEN'}
          </div>
        </div>
        
        {showSeller && (
          <div className="listing-seller small">
            Seller: {listing.seller.slice(0, 6)}...{listing.seller.slice(-4)}
          </div>
        )}
        
        <div className="listing-actions">
          {isOwner ? (
            <button className="secondary-button" disabled>You own this</button>
          ) : (
            <button 
              className="primary-button buy-button" 
              onClick={handleBuy} 
              disabled={status.includes('Buying')}
            >
              {status.includes('Buying') ? 'Processing...' : 'Buy Now'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default ListingCard;