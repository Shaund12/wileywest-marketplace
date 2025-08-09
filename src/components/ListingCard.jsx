import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { formatPriceWithUSDC, getTokenSymbol, fetchTokenDetails } from '../utils/tokenUtils';
import { resolveCollectionName, normalizeDescription, scopedClass } from '../utils/nftUtils';
import { debugWarn } from '../utils/debugUtils';
import PlaceholderImage from './PlaceholderImage';
import './ListingCard.css';

function ListingCard({ listing, featured = false, showSeller = true }) {
    const { buyListing, status } = useMarketplace();
    const { wallet, connect, provider } = useWallet();
    const [tokenSymbol, setTokenSymbol] = useState('TOKEN'); // Default to generic symbol
    const [priceDisplay, setPriceDisplay] = useState({
        tokenAmount: '...',
        tokenSymbol: 'TOKEN',
        usdcValue: '0.00',
        formatted: '...',
        hasUSDCRate: true
    });

    const handleBuy = async () => {
        if (!wallet) {
            await connect();
            return;
        }

        buyListing(listing.id, listing.pricePerUnit, listing.paymentToken);
    };

    const isOwner = wallet && listing.seller.toLowerCase() === wallet.toLowerCase();

    // Enhanced image URL resolution with multiple fallbacks
    const getImageUrl = () => {
        // Try multiple image sources in order of preference
        const sources = [
            listing.metadata?.image,
            listing.image,
            listing.imageUrl,
            listing.metadata?.image_url,
            listing.metadata?.imageUrl,
            listing.metadata?.animation_url // Some NFTs use animation_url for images
        ];
        
        for (const source of sources) {
            if (source && typeof source === 'string' && source.trim() !== '') {
                // Resolve IPFS URLs to HTTPS
                if (source.startsWith('ipfs://')) {
                    return source.replace('ipfs://', 'https://ipfs.io/ipfs/');
                }
                // Return other valid URLs as-is
                return source.trim();
            }
        }
        
        return null; // No valid image URL found
    };
    
    const imageUrl = getImageUrl();
    const imageSeed = `${listing.nftContract}${listing.tokenId}`;

    // Use centralized collection name resolution
    const nftName = resolveCollectionName(listing);
    
    // Normalize description
    const nftDescription = normalizeDescription(listing?.metadata?.description || listing.description);

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
                debugWarn('Error formatting price with USDC:', error);
                // Fallback to basic formatting
                const tokenDetails = await fetchTokenDetails(listing.paymentToken, provider).catch(() => ({
                    symbol: getTokenSymbol(listing.paymentToken),
                    decimals: 18
                }));
                
                setPriceDisplay({
                    tokenAmount: listing.pricePerUnit.toString(),
                    tokenSymbol: tokenDetails.symbol,
                    usdcValue: '0.00',
                    formatted: `${listing.pricePerUnit.toString()} ${tokenDetails.symbol}`,
                    hasUSDCRate: false
                });
                setTokenSymbol(tokenDetails.symbol);
            }
        }

        updatePriceDisplay();
    }, [listing, provider]);

    return (
        <article 
            className={`${scopedClass('listing-card', 'ListingCard')} ${featured ? scopedClass('featured', 'ListingCard') : ''}`}
            role="article"
            aria-label={`NFT listing: ${nftName}`}
        >
            <div className={scopedClass('listing-image', 'ListingCard')}>
                <PlaceholderImage
                    src={imageUrl}
                    alt={`${nftName} - NFT artwork`}
                    className={scopedClass('nft-image', 'ListingCard')}
                    seed={imageSeed}
                    width={300}
                    height={200}
                    contractAddress={listing.nftContract}
                    tokenId={listing.tokenId}
                    metadata={listing.metadata}
                />
            </div>


            <div className={scopedClass('listing-details', 'ListingCard')}>
                <div className={scopedClass('listing-info', 'ListingCard')}>
                    <h3 className={scopedClass('listing-title', 'ListingCard')}>{nftName}</h3>
                    <div className={`${scopedClass('listing-contract', 'ListingCard')} ${scopedClass('small', 'ListingCard')}`}>
                        {listing.nftContract.slice(0, 6)}...{listing.nftContract.slice(-4)}
                    </div>
                    {nftDescription && (
                        <p 
                            id={`description-${listing.id}`}
                            className={scopedClass('listing-description', 'ListingCard')}
                        >
                            {nftDescription}
                        </p>
                    )}
                </div>

                <div className={scopedClass('listing-price', 'ListingCard')} role="region" aria-label="Price information">
                    {priceDisplay.hasUSDCRate ? (
                        <>
                            <div className={scopedClass('price-amount', 'ListingCard')}>
                                ${priceDisplay.usdcValue}
                            </div>
                            <div className={scopedClass('price-currency', 'ListingCard')}>
                                USDC
                            </div>
                            {priceDisplay.tokenSymbol !== 'USDC.pol' && (
                                <div className={scopedClass('price-original', 'ListingCard')}>
                                    {priceDisplay.tokenAmount} {priceDisplay.tokenSymbol}
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            <div className={scopedClass('price-amount', 'ListingCard')}>
                                {priceDisplay.tokenAmount}
                            </div>
                            <div className={scopedClass('price-currency', 'ListingCard')}>
                                {priceDisplay.tokenSymbol}
                            </div>
                            <div className={scopedClass('price-note', 'ListingCard')}>
                                No USDC rate available
                            </div>
                        </>
                    )}
                </div>

                {showSeller && (
                    <div className={`${scopedClass('listing-seller', 'ListingCard')} ${scopedClass('small', 'ListingCard')}`}>
                        Seller: {listing.seller.slice(0, 6)}...{listing.seller.slice(-4)}
                    </div>
                )}

                <div className={scopedClass('listing-actions', 'ListingCard')}>
                    {isOwner ? (
                        <button 
                            className={scopedClass('secondary-button', 'ListingCard')} 
                            disabled 
                            aria-label="You own this NFT"
                        >
                            You own this
                        </button>
                    ) : (
                        <button
                            className={`${scopedClass('primary-button', 'ListingCard')} ${scopedClass('buy-button', 'ListingCard')}`}
                            onClick={handleBuy}
                            disabled={status.includes('Buying')}
                            aria-label={`Buy ${nftName} for ${priceDisplay.formatted}`}
                            aria-describedby={`price-${listing.id}`}
                        >
                            {status.includes('Buying') ? 'Processing...' : 'Buy Now'}
                        </button>
                    )}
                </div>
            </div>
            
            {/* Hidden price description for screen readers */}
            <div id={`price-${listing.id}`} className="sr-only">
                Price: {priceDisplay.formatted}
            </div>
        </article>
    );
}

export default ListingCard;