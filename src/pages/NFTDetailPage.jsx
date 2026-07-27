// src/pages/NFTDetailPage.jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { formatPriceWithUSDC, getTokenSymbol } from '../utils/tokenUtils';
import { loadNFTMetadata } from '../utils/metadataLoader';
import LoadingSkeleton from '../components/LoadingSkeleton';
import EmptyState from '../components/EmptyState';
import NFTImage from '../components/NFTImage';
import { activeChain } from '../config/chains.js';
import './NFTDetailPage.css';

const ERC721_METADATA_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
];

const shortAddr = (addr) => addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—';

export default function NFTDetailPage() {
    const { contractAddress, tokenId } = useParams();
    const navigate = useNavigate();
    const { listings, buyListing, status, createListing, updateListingPrice } = useMarketplace();
    const { wallet, provider, connect } = useWallet();

    // States
    const [nftData, setNftData] = useState(null);
    const [collectionInfo, setCollectionInfo] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [priceDisplay, setPriceDisplay] = useState(null);
    const [isOwner, setIsOwner] = useState(false);
    const [actualOwner, setActualOwner] = useState(null);
    
    // Edit listing price states
    const [isEditingPrice, setIsEditingPrice] = useState(false);
    const [newPrice, setNewPrice] = useState('');
    const [newPriceToken, setNewPriceToken] = useState(ethers.ZeroAddress);

    // Find the listing for this NFT
    const listing = listings.find(l => 
        l.nftContract && contractAddress &&
        l.nftContract.toLowerCase() === contractAddress.toLowerCase() &&
        String(l.tokenId) === String(tokenId)
    );

    // Load NFT metadata and collection info
    useEffect(() => {
        if (!contractAddress || !tokenId || !provider) return;

        const loadNFTData = async () => {
            setLoading(true);
            setError(null);

            try {
                // Load metadata using our enhanced loader
                const metadata = await loadNFTMetadata(contractAddress, tokenId, provider);
                console.log('Loaded metadata:', metadata); // Debug log
                
                setNftData({
                    contractAddress,
                    tokenId,
                    metadata
                });

                // Load collection info
                const contract = new ethers.Contract(contractAddress, ERC721_METADATA_ABI, provider);
                const [name, symbol] = await Promise.allSettled([
                    contract.name(),
                    contract.symbol()
                ]);

                setCollectionInfo({
                    name: name.status === 'fulfilled' ? name.value : 'Unknown Collection',
                    symbol: symbol.status === 'fulfilled' ? symbol.value : '',
                    address: contractAddress
                });

                // Check ownership
                try {
                    const owner = await contract.ownerOf(tokenId);
                    setActualOwner(owner);
                    setIsOwner(wallet && owner.toLowerCase() === wallet.toLowerCase());
                } catch (ownerError) {
                    console.warn('Could not determine NFT owner:', ownerError);
                }

            } catch (error) {
                console.error('Error loading NFT data:', error);
                setError(error.message);
            } finally {
                setLoading(false);
            }
        };

        loadNFTData();
    }, [contractAddress, tokenId, provider, wallet]);

    // Format price display for listing
    useEffect(() => {
        if (!listing || !provider) return;

        const formatPrice = async () => {
            try {
                const priceInfo = await formatPriceWithUSDC(listing.pricePerUnit, listing.paymentToken, provider, false);
                setPriceDisplay(priceInfo);
            } catch (error) {
                console.warn('Error formatting price:', error);
                setPriceDisplay({
                    tokenAmount: listing.pricePerUnit,
                    tokenSymbol: getTokenSymbol(listing.paymentToken),
                    formatted: `${listing.pricePerUnit} ${getTokenSymbol(listing.paymentToken)}`,
                    hasUSDCRate: false
                });
            }
        };

        formatPrice();
    }, [listing, provider]);

    const handleBuy = async () => {
        if (!wallet) {
            await connect();
            return;
        }

        if (!listing) return;

        const confirmText = `Buy ${nftData?.metadata?.name || `#${tokenId}`} for ${priceDisplay?.formatted || 'unknown price'}?`;
        if (window.confirm(confirmText)) {
            buyListing(listing.id, listing.pricePerUnit, listing.paymentToken);
        }
    };

    const handleUpdatePrice = async () => {
        if (!newPrice || !wallet || !listing) return;

        try {
            const success = await updateListingPrice(listing.id, newPrice);
            if (success) {
                setIsEditingPrice(false);
                setNewPrice('');
            }
        } catch (error) {
            console.error('Error updating price:', error);
        }
    };

    if (loading) {
        return (
            <div className="nft-detail-page">
                <div className="nft-detail-container">
                    <LoadingSkeleton type="nft-detail" />
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="nft-detail-page">
                <div className="nft-detail-container">
                    <EmptyState
                        icon="⚠️"
                        title="Failed to Load NFT"
                        description={`Error: ${error}`}
                        actionText="← Back to Marketplace"
                        onAction={() => navigate('/marketplace')}
                    />
                </div>
            </div>
        );
    }

    if (!nftData) {
        return (
            <div className="nft-detail-page">
                <div className="nft-detail-container">
                    <EmptyState
                        icon="🔍"
                        title="NFT Not Found"
                        description="This NFT doesn't exist or couldn't be loaded."
                        actionText="← Back to Marketplace"
                        onAction={() => navigate('/marketplace')}
                    />
                </div>
            </div>
        );
    }

    const metadata = nftData.metadata;
    const isListed = !!listing;
    const isOwnedByUser = isOwner && actualOwner;
    const canEditPrice = isOwnedByUser && isListed;

    return (
        <div className="nft-detail-page">
            <div className="nft-detail-container">
                {/* Back Navigation */}
                <div className="nft-detail-nav">
                    <button onClick={() => navigate(-1)} className="back-button">
                        ← Back
                    </button>
                    <div className="breadcrumb">
                        <Link to="/marketplace">Marketplace</Link>
                        <span className="separator">→</span>
                        <Link to={`/collections/${contractAddress}`}>
                            {collectionInfo?.name || shortAddr(contractAddress)}
                        </Link>
                        <span className="separator">→</span>
                        <span className="current">#{tokenId}</span>
                    </div>
                </div>

                <div className="nft-detail-content">
                    {/* Image Section */}
                    <div className="nft-detail-image-section">
                        <div className="nft-image-container">
                            <NFTImage
                                listing={listing}
                                contractAddress={contractAddress}
                                tokenId={tokenId}
                                alt={metadata?.name || `NFT #${tokenId}`}
                                className="nft-image"
                                width={400}
                                height={400}
                                placeholder="🖼️"
                                showRetry={true}
                            />
                        </div>

                        {/* Attributes */}
                        {metadata?.attributes && metadata.attributes.length > 0 && (
                            <div className="nft-attributes">
                                <h3>Attributes</h3>
                                <div className="attributes-grid">
                                    {metadata.attributes.map((attr, index) => (
                                        <div key={index} className="attribute-card">
                                            <div className="attribute-type">
                                                {attr.trait_type || 'Trait'}
                                            </div>
                                            <div className="attribute-value">
                                                {String(attr.value)}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Details Section */}
                    <div className="nft-detail-info-section">
                        {/* Collection Info */}
                        <div className="collection-badge">
                            <Link to={`/collections/${contractAddress}`} className="collection-link">
                                {collectionInfo?.name || 'Unknown Collection'}
                                {collectionInfo?.symbol && ` (${collectionInfo.symbol})`}
                            </Link>
                        </div>

                        {/* NFT Title */}
                        <h1 className="nft-title">
                            {metadata?.name || `NFT #${tokenId}`}
                        </h1>

                        {/* Description */}
                        {metadata?.description && (
                            <div className="nft-description">
                                <h3>Description</h3>
                                <p>{metadata.description}</p>
                            </div>
                        )}

                        {/* Price and Purchase Section */}
                        {isListed ? (
                            <div className="nft-price-section">
                                <div className="price-info">
                                    <div className="price-label">Current Price</div>
                                    {priceDisplay ? (
                                        <div className="price-display">
                                            <div className="price-primary">
                                                {priceDisplay.hasUSDCRate ? `$${priceDisplay.usdcValue}` : priceDisplay.tokenAmount}
                                            </div>
                                            <div className="price-secondary">
                                                {priceDisplay.hasUSDCRate && `${priceDisplay.tokenAmount} ${priceDisplay.tokenSymbol}`}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="price-loading">Loading price...</div>
                                    )}
                                </div>

                                {/* Seller Info */}
                                <div className="seller-info">
                                    <span className="seller-label">Seller:</span>
                                    <span className="seller-address">{shortAddr(listing.seller)}</span>
                                    {isOwnedByUser && <span className="owner-badge">You</span>}
                                </div>

                                {/* Action Buttons */}
                                <div className="nft-actions">
                                    {isOwnedByUser ? (
                                        <div className="owner-actions">
                                            {!isEditingPrice ? (
                                                <button 
                                                    className="edit-price-button"
                                                    onClick={() => setIsEditingPrice(true)}
                                                >
                                                    Edit Price
                                                </button>
                                            ) : (
                                                <div className="price-edit-form">
                                                    <input
                                                        type="number"
                                                        step="0.001"
                                                        placeholder={`New price in ${activeChain().symbol}`}
                                                        value={newPrice}
                                                        onChange={(e) => setNewPrice(e.target.value)}
                                                        className="price-input"
                                                    />
                                                    <div className="price-edit-actions">
                                                        <button 
                                                            className="save-price-button"
                                                            onClick={handleUpdatePrice}
                                                            disabled={!newPrice}
                                                        >
                                                            Update Price
                                                        </button>
                                                        <button 
                                                            className="cancel-edit-button"
                                                            onClick={() => {
                                                                setIsEditingPrice(false);
                                                                setNewPrice('');
                                                            }}
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                            <p className="owner-note">You own this NFT</p>
                                        </div>
                                    ) : (
                                        <button 
                                            className="buy-button"
                                            onClick={handleBuy}
                                            disabled={status && status.includes('Buying')}
                                        >
                                            {status && status.includes('Buying') ? 'Processing...' : 'Buy Now'}
                                        </button>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <div className="nft-not-listed">
                                <div className="not-listed-info">
                                    <h3>Not Currently Listed</h3>
                                    <p>This NFT is not available for purchase right now.</p>
                                    {actualOwner && (
                                        <p className="owner-info">
                                            Owner: {shortAddr(actualOwner)}
                                            {isOwnedByUser && ' (You)'}
                                        </p>
                                    )}
                                </div>
                                {isOwnedByUser && (
                                    <Link to="/sell" className="list-nft-button">
                                        List for Sale
                                    </Link>
                                )}
                            </div>
                        )}

                        {/* Contract Details */}
                        <div className="nft-contract-details">
                            <h3>Details</h3>
                            <div className="detail-row">
                                <span className="detail-label">Contract Address:</span>
                                <span className="detail-value">
                                    {contractAddress}
                                    <button 
                                        onClick={() => navigator.clipboard?.writeText(contractAddress)}
                                        className="copy-button"
                                        title="Copy address"
                                    >
                                        📋
                                    </button>
                                </span>
                            </div>
                            <div className="detail-row">
                                <span className="detail-label">Token ID:</span>
                                <span className="detail-value">{tokenId}</span>
                            </div>
                            <div className="detail-row">
                                <span className="detail-label">Token Standard:</span>
                                <span className="detail-value">ERC-721</span>
                            </div>
                            {listing && (
                                <div className="detail-row">
                                    <span className="detail-label">Listing ID:</span>
                                    <span className="detail-value">{listing.id}</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Status Messages */}
                {status && (
                    <div className="status-message">
                        {status}
                    </div>
                )}
            </div>
        </div>
    );
}
