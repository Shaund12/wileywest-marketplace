import React, { useState, useEffect, useRef } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import ListingCard from '../components/ListingCard';
import { convertToUSDCValue } from '../utils/tokenUtils';
import { ethers } from 'ethers';
import './MarketplacePage.css';

// Icons for the marketplace UI
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
    const { listings, hotListings, fetchListings, status, setStatus, isInitialized } = useMarketplace();
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
    const [collections, setCollections] = useState([]);
    const [stats, setStats] = useState({
        totalVolume: 0,
        totalListings: 0,
        avgPrice: 0,
        floorPrice: 0,
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

    // Process listings and extract metadata with USDC pricing
    useEffect(() => {
        async function processListingsWithUSDC() {
            if (listings.length > 0 && provider) {
                try {
                    // Extract collections and set up stats
                    const collectionMap = {};
                    let totalVolumeUSDC = 0;
                    let lowestPriceUSDC = Infinity;
                    const pricePromises = [];

                    // Process listings and collect price conversion promises
                    for (const listing of listings) {
                        const collectionAddress = listing.nftContract;
                        if (!collectionMap[collectionAddress]) {
                            collectionMap[collectionAddress] = {
                                address: collectionAddress,
                                name: listing.metadata?.collection?.name || `Collection ${collectionAddress.slice(0, 6)}...`,
                                items: [],
                                floorPrice: Infinity,
                                totalVolume: 0
                            };
                        }

                        collectionMap[collectionAddress].items.push(listing);

                        // Add promise to convert this listing's price to USDC
                        pricePromises.push(
                            convertToUSDCValue(listing.pricePerUnit, listing.paymentToken, provider)
                                .then(usdcPrice => ({ listing, usdcPrice }))
                                .catch(err => {
                                    console.warn(`Failed to convert price for listing ${listing.id}:`, err);
                                    return { listing, usdcPrice: 0 };
                                })
                        );
                    }

                    // Wait for all price conversions
                    const priceResults = await Promise.all(pricePromises);

                    // Update collections and stats with USDC prices
                    priceResults.forEach(({ listing, usdcPrice }) => {
                        const collectionAddress = listing.nftContract;
                        
                        collectionMap[collectionAddress].totalVolume += usdcPrice;
                        
                        if (usdcPrice < collectionMap[collectionAddress].floorPrice) {
                            collectionMap[collectionAddress].floorPrice = usdcPrice;
                        }

                        totalVolumeUSDC += usdcPrice;
                        if (usdcPrice < lowestPriceUSDC) lowestPriceUSDC = usdcPrice;
                    });

                    const collectionsList = Object.values(collectionMap).sort(
                        (a, b) => b.items.length - a.items.length
                    );

                    setCollections(collectionsList);

                    setStats({
                        totalVolume: totalVolumeUSDC.toFixed(2),
                        totalListings: listings.length,
                        avgPrice: (totalVolumeUSDC / listings.length).toFixed(2),
                        floorPrice: lowestPriceUSDC === Infinity ? '0.00' : lowestPriceUSDC.toFixed(2)
                    });

                    // Set a featured NFT (most expensive or first hot listing)
                    if (hotListings && hotListings.length > 0) {
                        setFeaturedNFT(hotListings[0]);
                    } else if (listings.length > 0) {
                        // Find the highest priced NFT based on USDC value
                        const highestPricedResult = priceResults.reduce((max, current) => {
                            return current.usdcPrice > max.usdcPrice ? current : max;
                        }, { usdcPrice: 0, listing: listings[0] });
                        setFeaturedNFT(highestPricedResult.listing);
                    }
                } catch (error) {
                    console.error('Error processing listings with USDC pricing:', error);
                    // Fallback to basic processing without USDC conversion
                    const collectionMap = {};
                    let totalVolume = 0;
                    let lowestPrice = Infinity;

                    listings.forEach(listing => {
                        const collectionAddress = listing.nftContract;
                        if (!collectionMap[collectionAddress]) {
                            collectionMap[collectionAddress] = {
                                address: collectionAddress,
                                name: listing.metadata?.collection?.name || `Collection ${collectionAddress.slice(0, 6)}...`,
                                items: [],
                                floorPrice: Infinity,
                                totalVolume: 0
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
                        totalVolume: `${totalVolume.toFixed(2)} (est.)`,
                        totalListings: listings.length,
                        avgPrice: `${(totalVolume / listings.length).toFixed(3)} (est.)`,
                        floorPrice: lowestPrice === Infinity ? '0.00 (est.)' : `${lowestPrice.toFixed(3)} (est.)`
                    });
                }
            }
        }

        processListingsWithUSDC();
    }, [listings, hotListings, provider]);

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
                                    {featuredNFT.metadata?.collection?.name || `Collection ${featuredNFT.nftContract.slice(0, 6)}...`}
                                </p>
                                <div className="featured-price">
                                    <span className="price-label">Price:</span>
                                    <span className="price-value">{formatPrice(featuredNFT.pricePerUnit)} VTRU</span>
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
                </div>
                <div className="stat-card">
                    <h3>${stats.totalVolume}</h3>
                    <p>Trading Volume (USDC)</p>
                </div>
                <div className="stat-card">
                    <h3>${stats.floorPrice}</h3>
                    <p>Floor Price (USDC)</p>
                </div>
                <div className="stat-card">
                    <h3>${stats.avgPrice}</h3>
                    <p>Average Price (USDC)</p>
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
                        <div className="collection-card" key={index}>
                            <div className="collection-preview">
                                {collection.items.slice(0, 4).map((item, i) => (
                                    <div className="preview-item" key={i}>
                                        <img
                                            src={item.image || item.imageUrl || '/placeholders/nft-placeholder.jpg'}
                                            alt={`Preview ${i}`}
                                        />
                                    </div>
                                ))}
                            </div>
                            <div className="collection-info">
                                <h3>{collection.name}</h3>
                                <div className="collection-stats">
                                    <div className="stat">
                                        <span className="value">{collection.items.length}</span>
                                        <span className="label">items</span>
                                    </div>
                                    <div className="stat">
                                        <span className="value">${collection.floorPrice.toFixed(2)}</span>
                                        <span className="label">floor (USDC)</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            {/* Main Marketplace Section */}
            <div className="main-marketplace">
                <div className="marketplace-header">
                    <h2>Browse NFTs</h2>
                    <div className="marketplace-actions">
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
                                        <label key={collection.address} className="filter-option">
                                            <input
                                                type="checkbox"
                                                checked={selectedCollections.includes(collection.address.toLowerCase())}
                                                onChange={() => toggleCollection(collection.address.toLowerCase())}
                                            />
                                            <span>{collection.name}</span>
                                            <span className="item-count">({collection.items.length})</span>
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
                                <p>{status || "Initializing marketplace..."}</p>
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
                    <img src="/marketplace-cta-image.jpg" alt="NFT Creation" />
                </div>
            </section>
        </div>
    );
}

export default MarketplacePage;