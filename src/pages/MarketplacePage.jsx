import React, { useState, useEffect, useRef } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import ListingCard from '../components/ListingCard';
import MarketplaceStats from '../components/MarketplaceStats';
import { convertToUSDCValue, formatPriceWithUSDC } from '../utils/tokenUtils';
import { ethers } from 'ethers';
import './MarketplacePage.css';
import '../components/MarketplaceStats.css';

// Icons for the marketplace UI
// Refresh Icon component
const RefreshIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="23 4 23 10 17 10"></polyline>
        <polyline points="1 20 1 14 7 14"></polyline>
        <path d="m3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
    </svg>
);

const SearchIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8"></circle>
        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
);

const FilterIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"></polygon>
    </svg>
);

const GridIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7"></rect>
        <rect x="14" y="3" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect>
        <rect x="3" y="14" width="7" height="7"></rect>
    </svg>
);

const ListIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="8" y1="6" x2="21" y2="6"></line>
        <line x1="8" y1="12" x2="21" y2="12"></line>
        <line x1="8" y1="18" x2="21" y2="18"></line>
        <line x1="3" y1="6" x2="3.01" y2="6"></line>
        <line x1="3" y1="12" x2="3.01" y2="12"></line>
        <line x1="3" y1="18" x2="3.01" y2="18"></line>
    </svg>
);

function MarketplacePage() {
    const { 
        listings, 
        hotListings, 
        fetchListings, 
        status, 
        setStatus, 
        isInitialized,
        marketplaceStats,
        canceledListings
    } = useMarketplace();
    const { wallet, connect, provider } = useWallet();
    const [searchTerm, setSearchTerm] = useState('');
    const [filteredListings, setFilteredListings] = useState([]);
    const [viewMode, setViewMode] = useState('grid');
    const [sortMethod, setSortMethod] = useState('newest');
    const [isLoading, setIsLoading] = useState(true);
    const [isFiltersOpen, setIsFiltersOpen] = useState(false);
    const [selectedCategories, setSelectedCategories] = useState([]);
    const [selectedCollections, setSelectedCollections] = useState([]);
    const [priceRange, setPriceRange] = useState({ min: '', max: '' });
    const [featuredNFT, setFeaturedNFT] = useState(null);
    const [featuredNFTPriceDisplay, setFeaturedNFTPriceDisplay] = useState({
        tokenAmount: '...',
        tokenSymbol: 'TOKEN',
        usdcValue: '0.00',
        formatted: '...',
        hasUSDCRate: true
    });
    const [collections, setCollections] = useState([]);
    const [stats, setStats] = useState({
        totalVolume: 0,
        totalListings: 0,
        avgPrice: 0,
        floorPrice: 0,
        currentListingVolume: 0,
        actualSoldVolume: 0,
        hasUSDCRates: true
    });
    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage] = useState(12);
    const topRef = useRef(null);
    const hasLoadedRef = useRef(false);

    // Categories for filtering
    const categories = [
        { id: 'art', name: 'Art' },
        { id: 'collectibles', name: 'Collectibles' },
        { id: 'photography', name: 'Photography' },
        { id: 'sports', name: 'Sports' },
        { id: 'utility', name: 'Utility' },
        { id: 'music', name: 'Music' },
        { id: 'gaming', name: 'Gaming' },
    ];

    // Load listings and process data
    useEffect(() => {
        async function loadData() {
            // Only fetch if we haven't loaded yet and marketplace is initialized
            if (!hasLoadedRef.current && isInitialized && fetchListings) {
                try {
                    console.log("[Marketplace] Initial data load");
                    setIsLoading(true);
                    await fetchListings();
                    hasLoadedRef.current = true; // Mark as loaded
                    console.log("[Marketplace] Initial data load complete");
                } catch (error) {
                    console.error("[Marketplace] Error fetching listings:", error);
                    setStatus("Error loading marketplace data");
                } finally {
                    setIsLoading(false);
                }
            }
        }
        
        loadData();
        
        // Manual refresh function - expose for refresh button
        window.refreshMarketplace = async () => {
            try {
                console.log("[Marketplace] Manual refresh triggered");
                setIsLoading(true);
                await fetchListings();
                console.log("[Marketplace] Manual refresh complete");
            } catch (error) {
                console.error("[Marketplace] Refresh error:", error);
            } finally {
                setIsLoading(false);
            }
        };
        
        // Clean up
        return () => {
            delete window.refreshMarketplace;
        };
    }, [isInitialized, fetchListings]);

    // Process listings and extract metadata with enhanced volume tracking
    useEffect(() => {
        async function processListingsWithEnhancedStats() {
            if (listings.length > 0 && provider) {
                try {
                    // Extract collections and set up stats
                    const collectionMap = {};
                    let currentListingVolumeUSDC = 0;
                    let lowestPriceUSDC = Infinity;
                    const pricePromises = [];
                    let hasAnyUSDCRates = false;

                    // Filter out canceled listings for current volume calculation
                    const activeListings = listings.filter(listing => 
                        listing.active && !canceledListings.has(listing.id?.toString())
                    );

                    // Process active listings and collect price conversion promises
                    for (const listing of activeListings) {
                        const collectionAddress = listing.nftContract;
                        if (!collectionMap[collectionAddress]) {
                            // Enhanced collection name resolution with multiple fallbacks and validation
                            let collectionName = `Collection ${collectionAddress.slice(0, 8)}...${collectionAddress.slice(-6)}`;
                            let collectionDescription = '';
                            let collectionImage = listing.image || listing.imageUrl;
                            let collectionWebsite = '';
                            
                            // Priority order for collection name with validation:
                            // 1. Direct collectionName property (from contract name())
                            // 2. metadata.collection.name 
                            // 3. metadata.name (if it doesn't look like a token name)
                            // 4. Enhanced fallback to better formatted address
                            if (listing.collectionName && listing.collectionName.trim() !== '' && 
                                !listing.collectionName.includes('Collection 0x')) {
                                collectionName = listing.collectionName.trim();
                                console.log(`✅ Using direct collection name: ${collectionName}`);
                            } else if (listing.metadata?.collection?.name && listing.metadata.collection.name.trim() !== '') {
                                collectionName = listing.metadata.collection.name.trim();
                                console.log(`📋 Using metadata collection name: ${collectionName}`);
                            } else if (listing.metadata?.name && 
                                       listing.metadata.name.trim() !== '' &&
                                       !listing.metadata.name.includes('#') && 
                                       !listing.metadata.name.toLowerCase().includes('token') &&
                                       !listing.metadata.name.toLowerCase().includes('nft')) {
                                collectionName = listing.metadata.name.trim();
                                console.log(`📝 Using NFT name as collection: ${collectionName}`);
                            } else {
                                console.log(`⚠️ Using fallback address for collection: ${collectionName}`);
                            }

                            // Extract additional collection information
                            if (listing.metadata?.collection) {
                                collectionDescription = listing.metadata.collection.description || '';
                                collectionImage = listing.metadata.collection.image || collectionImage;
                                collectionWebsite = listing.metadata.collection.external_link || listing.metadata.collection.external_url || '';
                            }

                            collectionMap[collectionAddress] = {
                                address: collectionAddress,
                                name: collectionName,
                                description: collectionDescription,
                                image: collectionImage,
                                website: collectionWebsite,
                                items: [],
                                floorPrice: Infinity,
                                totalVolume: 0,
                                // Enhanced collection stats
                                avgPrice: 0,
                                highestPrice: 0,
                                lowestPrice: Infinity,
                                createdAt: Date.now() // Track when we first saw this collection
                            };
                        }

                        collectionMap[collectionAddress].items.push(listing);

                        // Add promise to convert this listing's price to USDC
                        pricePromises.push(
                            convertToUSDCValue(listing.pricePerUnit, listing.paymentToken, provider)
                                .then(usdcPrice => {
                                    hasAnyUSDCRates = true;
                                    return { listing, usdcPrice, hasRate: true };
                                })
                                .catch(err => {
                                    console.warn(`Failed to convert price for listing ${listing.id}:`, err);
                                    return { listing, usdcPrice: 0, hasRate: false };
                                })
                        );
                    }

                    // Wait for all price conversions
                    const priceResults = await Promise.all(pricePromises);

                    // Update collections and stats with USDC prices
                    priceResults.forEach(({ listing, usdcPrice, hasRate }) => {
                        const collectionAddress = listing.nftContract;
                        
                        if (hasRate) {
                            collectionMap[collectionAddress].totalVolume += usdcPrice;
                            
                            // Enhanced collection price tracking
                            if (usdcPrice < collectionMap[collectionAddress].floorPrice) {
                                collectionMap[collectionAddress].floorPrice = usdcPrice;
                                collectionMap[collectionAddress].lowestPrice = usdcPrice;
                            }
                            
                            if (usdcPrice > collectionMap[collectionAddress].highestPrice) {
                                collectionMap[collectionAddress].highestPrice = usdcPrice;
                            }

                            currentListingVolumeUSDC += usdcPrice;
                            if (usdcPrice < lowestPriceUSDC) lowestPriceUSDC = usdcPrice;
                        }
                    });

                    // Calculate enhanced collection statistics
                    Object.values(collectionMap).forEach(collection => {
                        if (collection.items.length > 0) {
                            collection.avgPrice = collection.totalVolume / collection.items.length;
                            
                            // Fix infinite floor price display
                            if (collection.floorPrice === Infinity) {
                                collection.floorPrice = 0;
                                collection.lowestPrice = 0;
                            }
                        }
                    });

                    const collectionsList = Object.values(collectionMap).sort(
                        (a, b) => b.items.length - a.items.length
                    );

                    setCollections(collectionsList);

                    // Use marketplace stats for actual sold volume, current page stats for listing volume
                    const actualSoldVolume = marketplaceStats.actualSoldVolume || 0;
                    const totalSales = marketplaceStats.totalSales || 0;

                    setStats({
                        currentListingVolume: currentListingVolumeUSDC.toFixed(2),
                        actualSoldVolume: actualSoldVolume.toFixed(2),
                        totalListings: activeListings.length,
                        totalVolume: (currentListingVolumeUSDC + actualSoldVolume).toFixed(2),
                        avgPrice: activeListings.length > 0 ? (currentListingVolumeUSDC / activeListings.length).toFixed(2) : '0.00',
                        floorPrice: lowestPriceUSDC === Infinity ? '0.00' : lowestPriceUSDC.toFixed(2),
                        hasUSDCRates: hasAnyUSDCRates
                    });

                    // Set a featured NFT (most expensive or first hot listing)
                    if (hotListings && hotListings.length > 0) {
                        setFeaturedNFT(hotListings[0]);
                    } else if (activeListings.length > 0) {
                        // Find the highest priced NFT based on USDC value
                        const highestPricedResult = priceResults.reduce((max, current) => {
                            return current.usdcPrice > max.usdcPrice ? current : max;
                        }, { usdcPrice: 0, listing: activeListings[0] });
                        setFeaturedNFT(highestPricedResult.listing);
                    }
                } catch (error) {
                    console.error('Error processing listings with enhanced stats:', error);
                    // Fallback to basic processing without USDC conversion
                    const activeListings = listings.filter(listing => 
                        listing.active && !canceledListings.has(listing.id?.toString())
                    );
                    
                    const collectionMap = {};
                    let totalVolume = 0;
                    let lowestPrice = Infinity;

                    activeListings.forEach(listing => {
                        const collectionAddress = listing.nftContract;
                        if (!collectionMap[collectionAddress]) {
                            // Use the same enhanced collection name resolution in fallback
                            let collectionName = `Collection ${collectionAddress.slice(0, 8)}...${collectionAddress.slice(-6)}`;
                            if (listing.collectionName && listing.collectionName.trim() !== '' && 
                                !listing.collectionName.includes('Collection 0x')) {
                                collectionName = listing.collectionName.trim();
                            } else if (listing.metadata?.collection?.name && listing.metadata.collection.name.trim() !== '') {
                                collectionName = listing.metadata.collection.name.trim();
                            } else if (listing.metadata?.name && 
                                       listing.metadata.name.trim() !== '' &&
                                       !listing.metadata.name.includes('#') && 
                                       !listing.metadata.name.toLowerCase().includes('token') &&
                                       !listing.metadata.name.toLowerCase().includes('nft')) {
                                collectionName = listing.metadata.name.trim();
                            }

                            collectionMap[collectionAddress] = {
                                address: collectionAddress,
                                name: collectionName,
                                description: listing.metadata?.collection?.description || '',
                                image: listing.metadata?.collection?.image || listing.image || listing.imageUrl,
                                website: listing.metadata?.collection?.external_link || '',
                                items: [],
                                floorPrice: Infinity,
                                totalVolume: 0,
                                avgPrice: 0,
                                highestPrice: 0,
                                lowestPrice: Infinity
                            };
                        }

                        const priceInEth = parseFloat(ethers.formatEther(listing.pricePerUnit));
                        collectionMap[collectionAddress].items.push(listing);
                        collectionMap[collectionAddress].totalVolume += priceInEth;

                        if (priceInEth < collectionMap[collectionAddress].floorPrice) {
                            collectionMap[collectionAddress].floorPrice = priceInEth;
                        }

                        totalVolume += priceInEth;
                        if (priceInEth < lowestPrice) lowestPrice = priceInEth;
                    });

                    const collectionsList = Object.values(collectionMap).sort(
                        (a, b) => b.items.length - a.items.length
                    );

                    setCollections(collectionsList);

                    setStats({
                        currentListingVolume: `${totalVolume.toFixed(2)} (no USDC rate available)`,
                        actualSoldVolume: '0.00 (no USDC rate available)',
                        totalListings: activeListings.length,
                        totalVolume: `${totalVolume.toFixed(2)} (no USDC rate available)`,
                        avgPrice: activeListings.length > 0 ? `${(totalVolume / activeListings.length).toFixed(3)} (est.)` : '0.00',
                        floorPrice: lowestPrice === Infinity ? '0.00' : `${lowestPrice.toFixed(3)} (est.)`,
                        hasUSDCRates: false
                    });
                }
            } else {
                // Set default stats when no listings
                setStats({
                    currentListingVolume: '0.00',
                    actualSoldVolume: marketplaceStats.actualSoldVolume?.toFixed(2) || '0.00',
                    totalListings: 0,
                    totalVolume: '0.00',
                    avgPrice: '0.00',
                    floorPrice: '0.00',
                    hasUSDCRates: true
                });
            }
        }

        processListingsWithEnhancedStats();
    }, [listings, hotListings, provider, canceledListings, marketplaceStats]);

    // Update featured NFT price display
    useEffect(() => {
        async function updateFeaturedNFTPriceDisplay() {
            if (!featuredNFT || !featuredNFT.pricePerUnit || !provider) {
                setFeaturedNFTPriceDisplay({
                    tokenAmount: '...',
                    tokenSymbol: 'TOKEN',
                    usdcValue: '0.00',
                    formatted: '...',
                    hasUSDCRate: true
                });
                return;
            }

            try {
                // Use the same price formatting logic as ListingCard
                const priceInfo = await formatPriceWithUSDC(
                    featuredNFT.pricePerUnit, 
                    featuredNFT.paymentToken, 
                    provider,
                    true // Show both token amount and USDC value for featured display
                );
                
                setFeaturedNFTPriceDisplay(priceInfo);
            } catch (error) {
                console.error('Error formatting featured NFT price with USDC:', error);
                // Fallback to basic formatting
                const tokenSymbol = featuredNFT.paymentToken ? 
                    (featuredNFT.paymentToken === ethers.ZeroAddress ? 'VTRU' : 'TOKEN') : 
                    'VTRU';
                const tokenAmount = formatPrice(featuredNFT.pricePerUnit);
                
                setFeaturedNFTPriceDisplay({
                    tokenAmount,
                    tokenSymbol,
                    usdcValue: '0.00',
                    formatted: `${tokenAmount} ${tokenSymbol}`,
                    hasUSDCRate: false
                });
            }
        }

        updateFeaturedNFTPriceDisplay();
    }, [featuredNFT, provider]);

    // Filter and sort listings
    useEffect(() => {
        let result = [...listings];

        // Apply search filter
        if (searchTerm) {
            const term = searchTerm.toLowerCase();
            result = result.filter(
                item =>
                    (item.name?.toLowerCase().includes(term)) ||
                    (item.metadata?.name?.toLowerCase().includes(term)) ||
                    (item.metadata?.description?.toLowerCase().includes(term)) ||
                    item.tokenId.toString().includes(term)
            );
        }

        // Apply category filters
        if (selectedCategories.length > 0) {
            result = result.filter(item => {
                const category = item.metadata?.properties?.category ||
                    item.metadata?.attributes?.find(attr => attr.trait_type === 'Category')?.value;
                return category && selectedCategories.includes(category.toLowerCase());
            });
        }

        // Apply collection filters
        if (selectedCollections.length > 0) {
            result = result.filter(item =>
                selectedCollections.includes(item.nftContract.toLowerCase())
            );
        }

        // Apply price filters
        if (priceRange.min !== '') {
            const minWei = ethers.parseEther(priceRange.min.toString());
            result = result.filter(item => ethers.getBigInt(item.pricePerUnit) >= minWei);
        }
        if (priceRange.max !== '') {
            const maxWei = ethers.parseEther(priceRange.max.toString());
            result = result.filter(item => ethers.getBigInt(item.pricePerUnit) <= maxWei);
        }

        // Apply sorting
        switch (sortMethod) {
            case 'price_low_to_high':
                result.sort((a, b) => ethers.getBigInt(a.pricePerUnit) - ethers.getBigInt(b.pricePerUnit));
                break;
            case 'price_high_to_low':
                result.sort((a, b) => ethers.getBigInt(b.pricePerUnit) - ethers.getBigInt(a.pricePerUnit));
                break;
            case 'newest':
                // Assuming higher IDs are newer listings
                result.sort((a, b) => b.id - a.id);
                break;
            case 'oldest':
                result.sort((a, b) => a.id - b.id);
                break;
        }

        setFilteredListings(result);
    }, [listings, searchTerm, sortMethod, selectedCategories, selectedCollections, priceRange]);

    // Calculate pagination
    const indexOfLastItem = currentPage * itemsPerPage;
    const indexOfFirstItem = indexOfLastItem - itemsPerPage;
    const currentItems = filteredListings.slice(indexOfFirstItem, indexOfLastItem);
    const totalPages = Math.ceil(filteredListings.length / itemsPerPage);

    const paginate = (pageNumber) => {
        setCurrentPage(pageNumber);
        topRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    // Toggle category selection
    const toggleCategory = (categoryId) => {
        if (selectedCategories.includes(categoryId)) {
            setSelectedCategories(selectedCategories.filter(cat => cat !== categoryId));
        } else {
            setSelectedCategories([...selectedCategories, categoryId]);
        }
    };

    // Toggle collection selection
    const toggleCollection = (collectionAddress) => {
        if (selectedCollections.includes(collectionAddress)) {
            setSelectedCollections(selectedCollections.filter(col => col !== collectionAddress));
        } else {
            setSelectedCollections([...selectedCollections, collectionAddress]);
        }
    };

    // Format price display
    const formatPrice = (priceInWei) => {
        try {
            return parseFloat(ethers.formatEther(priceInWei)).toFixed(4);
        } catch (e) {
            return '0';
        }
    };

    return (
        <div className="marketplace-container" ref={topRef}>
            {/* Hero Section */}
            <div className="marketplace-hero">
                <div className="hero-content">
                    <h1>Discover, Collect & Sell<br /><span className="gradient-text">Extraordinary NFTs</span></h1>
                    <p>Explore the most sought-after digital assets in the Vitruveo ecosystem</p>
                    <div className="hero-cta">
                        {wallet ? (
                            <a href="/sell" className="primary-button">Create Listing</a>
                        ) : (
                            <button className="primary-button" onClick={connect}>Connect Wallet</button>
                        )}
                        <button className="secondary-button" onClick={() => window.scrollTo({ top: document.querySelector('.marketplace-stats').offsetTop, behavior: 'smooth' })}>
                            Browse Marketplace
                        </button>
                    </div>
                </div>
                <div className="hero-featured-nft">
                    {featuredNFT && (
                        <div className="featured-nft-card">
                            <div className="featured-badge">Featured</div>
                            <div className="featured-image">
                                <img
                                    src={featuredNFT.image || featuredNFT.imageUrl || '/placeholders/nft-placeholder.jpg'}
                                    alt={featuredNFT.name || `NFT #${featuredNFT.tokenId}`}
                                />
                            </div>
                            <div className="featured-details">
                                <h3>{featuredNFT.name || featuredNFT.metadata?.name || `NFT #${featuredNFT.tokenId}`}</h3>
                                <p className="featured-collection">
                                    {(featuredNFT.collectionName && featuredNFT.collectionName.trim() !== '' && !featuredNFT.collectionName.includes('Collection 0x')) ? 
                                     featuredNFT.collectionName.trim() :
                                     (featuredNFT.metadata?.collection?.name && featuredNFT.metadata.collection.name.trim() !== '') ?
                                     featuredNFT.metadata.collection.name.trim() :
                                     (featuredNFT.metadata?.name && featuredNFT.metadata.name.trim() !== '' && !featuredNFT.metadata.name.includes('#') && !featuredNFT.metadata.name.toLowerCase().includes('token') && !featuredNFT.metadata.name.toLowerCase().includes('nft')) ?
                                     featuredNFT.metadata.name.trim() :
                                     `${featuredNFT.nftContract.slice(0, 8)}...${featuredNFT.nftContract.slice(-6)}`}
                                </p>
                                {featuredNFT.metadata?.collection?.description && (
                                    <p className="featured-description">
                                        {featuredNFT.metadata.collection.description.slice(0, 80)}
                                        {featuredNFT.metadata.collection.description.length > 80 ? '...' : ''}
                                    </p>
                                )}
                                <div className="featured-price">
                                    <span className="price-label">Price:</span>
                                    <span className="price-value">
                                        {featuredNFTPriceDisplay.hasUSDCRate ? (
                                            featuredNFTPriceDisplay.formatted
                                        ) : (
                                            `${featuredNFTPriceDisplay.tokenAmount} ${featuredNFTPriceDisplay.tokenSymbol}`
                                        )}
                                    </span>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Marketplace Stats */}
            <div className="marketplace-stats">
                <div className="stat-card">
                    <h3>{stats.totalListings}</h3>
                    <p>Active Listings</p>
                    <small>(Excluding canceled)</small>
                </div>
                <div className="stat-card">
                    <h3>{stats.hasUSDCRates ? `$${stats.currentListingVolume}` : stats.currentListingVolume}</h3>
                    <p>Current Listing Volume</p>
                    <small>{stats.hasUSDCRates ? 'USDC' : 'Native tokens'}</small>
                </div>
                <div className="stat-card">
                    <h3>{stats.hasUSDCRates ? `$${stats.actualSoldVolume}` : stats.actualSoldVolume}</h3>
                    <p>Actual Sold Volume</p>
                    <small>{stats.hasUSDCRates ? 'USDC' : 'Native tokens'}</small>
                </div>
                <div className="stat-card">
                    <h3>{stats.hasUSDCRates ? `$${stats.floorPrice}` : stats.floorPrice}</h3>
                    <p>Floor Price</p>
                    <small>{stats.hasUSDCRates ? 'USDC' : 'Estimated'}</small>
                </div>
            </div>

            {/* Hot Collections Carousel */}
            <section className="hot-collections">
                <div className="section-header">
                    <h2>Popular Collections</h2>
                    <button className="see-all-button">See All</button>
                </div>

                <div className="collections-carousel">
                    {collections.slice(0, 5).map((collection, index) => (
                        <div className="collection-card enhanced" key={index}>
                            <div className="collection-header">
                                <div className="collection-avatar">
                                    <img
                                        src={collection.image || collection.items[0]?.image || collection.items[0]?.imageUrl || '/placeholders/nft-placeholder.jpg'}
                                        alt={collection.name}
                                    />
                                </div>
                                <div className="collection-rank">#{index + 1}</div>
                            </div>
                            <div className="collection-preview">
                                {collection.items.slice(0, 4).map((item, i) => (
                                    <div className="preview-item" key={i}>
                                        <img
                                            src={item.image || item.imageUrl || '/placeholders/nft-placeholder.jpg'}
                                            alt={`Preview ${i}`}
                                        />
                                    </div>
                                ))}
                                {collection.items.length > 4 && (
                                    <div className="preview-item more-items">
                                        <span>+{collection.items.length - 4}</span>
                                    </div>
                                )}
                            </div>
                            <div className="collection-info">
                                <h3 title={collection.name}>{collection.name}</h3>
                                {collection.description && (
                                    <p className="collection-description" title={collection.description}>
                                        {collection.description.slice(0, 60)}{collection.description.length > 60 ? '...' : ''}
                                    </p>
                                )}
                                <div className="collection-stats">
                                    <div className="stat">
                                        <span className="value">{collection.items.length}</span>
                                        <span className="label">items</span>
                                    </div>
                                    <div className="stat">
                                        <span className="value">${collection.floorPrice > 0 ? collection.floorPrice.toFixed(2) : '0.00'}</span>
                                        <span className="label">floor</span>
                                    </div>
                                    <div className="stat">
                                        <span className="value">${collection.totalVolume.toFixed(2)}</span>
                                        <span className="label">volume</span>
                                    </div>
                                    <div className="stat">
                                        <span className="value">${collection.avgPrice > 0 ? collection.avgPrice.toFixed(2) : '0.00'}</span>
                                        <span className="label">avg price</span>
                                    </div>
                                </div>
                                {collection.website && (
                                    <div className="collection-links">
                                        <a href={collection.website} target="_blank" rel="noopener noreferrer" className="website-link">
                                            🌐 Website
                                        </a>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* Detailed Marketplace Statistics */}
            <MarketplaceStats />

            {/* Trending Collections Detailed View */}
            {collections.length > 0 && (
                <section className="trending-collections">
                    <div className="section-header">
                        <h2>Trending Collections</h2>
                        <div className="trend-filters">
                            <button className="trend-filter active">📈 Volume</button>
                            <button className="trend-filter">🔥 Hot</button>
                            <button className="trend-filter">⭐ New</button>
                        </div>
                    </div>
                    
                    <div className="trending-collections-grid">
                        {collections.slice(0, 6).map((collection, index) => (
                            <div className="trending-collection-card" key={collection.address}>
                                <div className="trending-rank">#{index + 1}</div>
                                <div className="trending-collection-header">
                                    <div className="trending-avatar">
                                        <img
                                            src={collection.image || collection.items[0]?.image || '/placeholders/nft-placeholder.jpg'}
                                            alt={collection.name}
                                        />
                                    </div>
                                    <div className="trending-info">
                                        <h4>{collection.name}</h4>
                                        <p>{collection.items.length} items</p>
                                    </div>
                                    <div className="trending-change">
                                        <span className="change-percentage">+12.5%</span>
                                        <span className="change-label">24h</span>
                                    </div>
                                </div>
                                
                                <div className="trending-metrics">
                                    <div className="metric">
                                        <span className="metric-label">Floor Price</span>
                                        <span className="metric-value">${collection.floorPrice > 0 ? collection.floorPrice.toFixed(2) : '0.00'}</span>
                                    </div>
                                    <div className="metric">
                                        <span className="metric-label">Volume</span>
                                        <span className="metric-value">${collection.totalVolume.toFixed(2)}</span>
                                    </div>
                                    <div className="metric">
                                        <span className="metric-label">Avg Price</span>
                                        <span className="metric-value">${collection.avgPrice > 0 ? collection.avgPrice.toFixed(2) : '0.00'}</span>
                                    </div>
                                    <div className="metric">
                                        <span className="metric-label">Items</span>
                                        <span className="metric-value">{collection.items.length}</span>
                                    </div>
                                </div>
                                
                                <div className="trending-preview-small">
                                    {collection.items.slice(0, 3).map((item, i) => (
                                        <img
                                            key={i}
                                            src={item.image || item.imageUrl || '/placeholders/nft-placeholder.jpg'}
                                            alt={`${collection.name} item ${i+1}`}
                                        />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* Main Marketplace Section */}
            <div className="main-marketplace">
                <div className="marketplace-header">
                    <div className="header-content">
                        <h2>Browse NFTs</h2>
                        {status && (
                            <div className="cache-status">
                                <span className="status-indicator">{status}</span>
                            </div>
                        )}
                    </div>
                    <div className="marketplace-actions">
                        <button
                            className="refresh-button"
                            onClick={() => fetchListings(true)}
                            disabled={isLoading}
                            title="Refresh listings from blockchain"
                        >
                            <RefreshIcon /> 
                            {isLoading ? 'Loading...' : 'Refresh'}
                        </button>
                        <button
                            className={`filter-button ${isFiltersOpen ? 'active' : ''}`}
                            onClick={() => setIsFiltersOpen(!isFiltersOpen)}
                        >
                            <FilterIcon /> Filters
                        </button>
                        <div className="search-bar">
                            <SearchIcon />
                            <input
                                type="text"
                                placeholder="Search by name or token ID"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                            />
                        </div>
                        <select
                            className="sort-select"
                            value={sortMethod}
                            onChange={(e) => setSortMethod(e.target.value)}
                        >
                            <option value="newest">Newest</option>
                            <option value="oldest">Oldest</option>
                            <option value="price_low_to_high">Price: Low to High</option>
                            <option value="price_high_to_low">Price: High to Low</option>
                        </select>
                        <div className="view-options">
                            <button
                                className={`view-option ${viewMode === 'grid' ? 'active' : ''}`}
                                onClick={() => setViewMode('grid')}
                                title="Grid View"
                            >
                                <GridIcon />
                            </button>
                            <button
                                className={`view-option ${viewMode === 'list' ? 'active' : ''}`}
                                onClick={() => setViewMode('list')}
                                title="List View"
                            >
                                <ListIcon />
                            </button>
                        </div>
                    </div>
                </div>

                <div className="marketplace-content">
                    {/* Filters Sidebar */}
                    {isFiltersOpen && (
                        <div className="filters-sidebar">
                            <div className="filter-group">
                                <h3>Categories</h3>
                                <div className="filter-options">
                                    {categories.map(category => (
                                        <label key={category.id} className="filter-option">
                                            <input
                                                type="checkbox"
                                                checked={selectedCategories.includes(category.id)}
                                                onChange={() => toggleCategory(category.id)}
                                            />
                                            <span>{category.name}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div className="filter-group">
                                <h3>Collections</h3>
                                <div className="filter-options scrollable">
                                    {collections.slice(0, 10).map(collection => (
                                        <label key={collection.address} className="filter-option collection-filter">
                                            <input
                                                type="checkbox"
                                                checked={selectedCollections.includes(collection.address.toLowerCase())}
                                                onChange={() => toggleCollection(collection.address.toLowerCase())}
                                            />
                                            <div className="collection-filter-info">
                                                <div className="collection-filter-avatar">
                                                    <img 
                                                        src={collection.image || collection.items[0]?.image || '/placeholders/nft-placeholder.jpg'} 
                                                        alt={collection.name}
                                                    />
                                                </div>
                                                <div className="collection-filter-details">
                                                    <span className="collection-name">{collection.name}</span>
                                                    <span className="collection-stats">
                                                        {collection.items.length} items • Floor: ${collection.floorPrice > 0 ? collection.floorPrice.toFixed(2) : '0.00'}
                                                    </span>
                                                </div>
                                            </div>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div className="filter-group">
                                <h3>Price Range (VTRU)</h3>
                                <div className="price-inputs">
                                    <input
                                        type="number"
                                        placeholder="Min"
                                        value={priceRange.min}
                                        onChange={e => setPriceRange({ ...priceRange, min: e.target.value })}
                                        min="0"
                                        step="0.001"
                                    />
                                    <span className="price-range-separator">to</span>
                                    <input
                                        type="number"
                                        placeholder="Max"
                                        value={priceRange.max}
                                        onChange={e => setPriceRange({ ...priceRange, max: e.target.value })}
                                        min="0"
                                        step="0.001"
                                    />
                                </div>
                            </div>

                            <button
                                className="clear-filters-button"
                                onClick={() => {
                                    setSelectedCategories([]);
                                    setSelectedCollections([]);
                                    setPriceRange({ min: '', max: '' });
                                }}
                            >
                                Clear All Filters
                            </button>
                        </div>
                    )}

                    {/* NFT Listings */}
                    <div className={`listings-container ${viewMode}`}>
                        {!isInitialized ? (
                            <div className="loading-container">
                                <div className="loading-spinner"></div>
                                <p>Initializing marketplace...</p>
                            </div>
                        ) : isLoading ? (
                            <div className="loading-container">
                                <div className="loading-spinner"></div>
                                <p>Loading NFTs...</p>
                            </div>
                        ) : currentItems.length > 0 ? (
                            <>
                                <div className={`listings-${viewMode}`}>
                                    {currentItems.map(listing => (
                                        <ListingCard
                                            key={listing.id}
                                            listing={listing}
                                            viewMode={viewMode}
                                        />
                                    ))}
                                </div>

                                {/* Pagination */}
                                {totalPages > 1 && (
                                    <div className="pagination">
                                        <button
                                            onClick={() => paginate(1)}
                                            disabled={currentPage === 1}
                                            className="pagination-button"
                                        >
                                            First
                                        </button>
                                        <button
                                            onClick={() => paginate(currentPage - 1)}
                                            disabled={currentPage === 1}
                                            className="pagination-button"
                                        >
                                            Previous
                                        </button>

                                        <div className="pagination-info">
                                            Page {currentPage} of {totalPages}
                                        </div>

                                        <button
                                            onClick={() => paginate(currentPage + 1)}
                                            disabled={currentPage === totalPages}
                                            className="pagination-button"
                                        >
                                            Next
                                        </button>
                                        <button
                                            onClick={() => paginate(totalPages)}
                                            disabled={currentPage === totalPages}
                                            className="pagination-button"
                                        >
                                            Last
                                        </button>
                                    </div>
                                )}
                            </>
                        ) : (
                            <div className="no-listings-found">
                                <div className="empty-icon">🔍</div>
                                <h3>No NFTs Found</h3>
                                {searchTerm || selectedCategories.length > 0 || selectedCollections.length > 0 ||
                                    priceRange.min !== '' || priceRange.max !== '' ? (
                                    <p>Try adjusting your filters or search criteria</p>
                                ) : (
                                    <p>There are currently no active listings in the marketplace</p>
                                )}
                                <button className="primary-button" onClick={() => {
                                    setSearchTerm('');
                                    setSelectedCategories([]);
                                    setSelectedCollections([]);
                                    setPriceRange({ min: '', max: '' });
                                    fetchListings();
                                }}>
                                    Refresh Marketplace
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Status message */}
            {status && <div className="status-message">{status}</div>}

            {/* Call-to-action Section */}
            <section className="marketplace-cta">
                <div className="cta-content">
                    <h2>Ready to list your NFTs?</h2>
                    <p>Join creators and collectors in the vibrant Vitruveo marketplace</p>
                    <div className="cta-buttons">
                        {wallet ? (
                            <a href="/sell" className="primary-button">Create a Listing</a>
                        ) : (
                            <button className="primary-button" onClick={connect}>Connect Wallet</button>
                        )}
                        <a href="/profile" className="secondary-button">View Your Profile</a>
                    </div>
                </div>
                <div className="cta-image">
                    <img src="src/assets/blockdust-logo.png" alt="WileyW€$T NFT Marketplace" />
                </div>
            </section>
        </div>
    );
}

export default MarketplacePage;