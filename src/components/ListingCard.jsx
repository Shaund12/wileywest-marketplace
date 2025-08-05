import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { formatPriceWithUSDC, getTokenSymbol, fetchTokenDetails } from '../utils/tokenUtils';

function ListingCard({ listing, featured = false, showSeller = true }) {
    const { buyListing, status } = useMarketplace();
    const { wallet, connect, provider } = useWallet();
    const [tokenSymbol, setTokenSymbol] = useState('TOKEN'); // Default to generic symbol
    const [priceDisplay, setPriceDisplay] = useState({
        tokenAmount: '...',
        tokenSymbol: 'TOKEN',
        usdcValue: '0.00',
        formatted: '...'
    });

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
        async function updatePriceDisplay() {
            if (!listing.pricePerUnit || !provider) return;

            try {
                // Use the enhanced USDC price formatting
                const priceInfo = await formatPriceWithUSDC(
                    listing.pricePerUnit, 
                    listing.paymentToken, 
                    provider,
                    false // Show only USDC value for cleaner display
                );
                
                setPriceDisplay(priceInfo);
                setTokenSymbol(priceInfo.tokenSymbol);
            } catch (error) {
                console.error('Error formatting price with USDC:', error);
                // Fallback to basic formatting
                const tokenDetails = await fetchTokenDetails(listing.paymentToken, provider).catch(() => ({
                    symbol: getTokenSymbol(listing.paymentToken),
                    decimals: 18
                }));
                
                setPriceDisplay({
                    tokenAmount: listing.pricePerUnit.toString(),
                    tokenSymbol: tokenDetails.symbol,
                    usdcValue: '0.00',
                    formatted: `${listing.pricePerUnit.toString()} ${tokenDetails.symbol}`
                });
                setTokenSymbol(tokenDetails.symbol);
            }
        }

        updatePriceDisplay();
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
                        ${priceDisplay.usdcValue}
                    </div>
                    <div className="price-currency">
                        USDC
                    </div>
                    {priceDisplay.tokenSymbol !== 'USDC.pol' && (
                        <div className="price-original">
                            {priceDisplay.tokenAmount} {priceDisplay.tokenSymbol}
                        </div>
                    )}
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