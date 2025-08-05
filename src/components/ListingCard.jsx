import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { formatTokenAmount, getTokenSymbol, fetchTokenDetails } from '../utils/tokenUtils';

function ListingCard({ listing, featured = false, showSeller = true }) {
    const { buyListing, status } = useMarketplace();
    const { wallet, connect, provider } = useWallet();
    const [tokenSymbol, setTokenSymbol] = useState('TOKEN'); // Default to generic symbol
    const [displayPrice, setDisplayPrice] = useState('...');

    const handleBuy = async () => {
        if (!wallet) {
            await connect();
            return;
        }

        buyListing(listing.id, listing.pricePerUnit, listing.paymentToken);
    };

    const isOwner = wallet && listing.seller.toLowerCase() === wallet.toLowerCase();

    // Use the actual NFT image from metadata if available, fallback to placeholder
    const fallbackImage = `https://picsum.photos/seed/${listing.nftContract}${listing.tokenId}/300/300`;
    const imageUrl = listing.metadata?.image || listing.image || listing.imageUrl || fallbackImage;

    // Use the NFT name from metadata if available
    const nftName = listing.metadata?.name || listing.name || `NFT #${listing.tokenId.toString()}`;

    // Format price and fetch token details when component mounts or listing changes
    useEffect(() => {
        // Format the price
        if (listing.pricePerUnit) {
            const formattedPrice = formatTokenAmount(listing.pricePerUnit, listing.paymentToken);
            setDisplayPrice(formattedPrice);
        }

        // Fetch token symbol from blockchain
        if (provider && listing.paymentToken && listing.paymentToken.startsWith('0x')) {
            console.log(`Fetching token details for ${listing.paymentToken}`);
            fetchTokenDetails(listing.paymentToken, provider)
                .then(details => {
                    console.log(`Token details for ${listing.paymentToken}:`, details);
                    setTokenSymbol(details.symbol);
                })
                .catch(err => {
                    console.error(`Error fetching token details:`, err);
                });
        }
    }, [listing, provider]);

    return (
        <div className={`listing-card ${featured ? 'featured' : ''}`}>
            <div className="listing-image">
                <img
                    src={imageUrl}
                    alt={nftName}
                    onError={(e) => {
                        console.log("Image failed to load:", e.target.src);
                        e.target.src = fallbackImage;
                    }}
                />
            </div>

            <div className="listing-details">
                <div className="listing-info">
                    <h3>{nftName}</h3>
                    <div className="listing-contract small">{listing.nftContract.slice(0, 6)}...{listing.nftContract.slice(-4)}</div>
                </div>

                <div className="listing-price">
                    <div className="price-amount">
                        {displayPrice}
                    </div>
                    <div className="price-currency">
                        {tokenSymbol}
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