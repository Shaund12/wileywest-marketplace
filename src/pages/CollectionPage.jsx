// pages/CollectionPage.jsx
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import LoadingSkeleton from '../components/LoadingSkeleton';
import EmptyState from '../components/EmptyState';
import ListingCard from '../components/ListingCard';
import { formatPriceWithUSDC, convertToUSDCValue } from '../utils/tokenUtils';
import './CollectionPage.css';

const ERC721_METADATA_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
];

const isAddress = (s) => /^0x[a-fA-F0-9]{40}$/.test(s || '');

// Utility functions
const shortAddr = (addr) => addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '—';
const formatNumber = (num) => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toString();
};

const formatPrice = (price) => {
    if (!price || price === '0') return '$0.00';
    try {
        const ethValue = ethers.formatEther(price);
        const numValue = parseFloat(ethValue);
        if (numValue < 0.001) return `$${numValue.toFixed(6)}`;
        return `$${numValue.toFixed(3)}`;
    } catch {
        return '$0.00';
    }
};

export default function CollectionPage() {
    const { address = '' } = useParams();
    const addr = address.toLowerCase();
    const { listings = [], isInitialized, fetchListings } = useMarketplace();
    const { provider } = useWallet();

    // Collection metadata state
    const [collectionData, setCollectionData] = useState({
        name: '',
        symbol: '',
        totalSupply: 0,
        loading: false
    });

    // UI state
    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage] = useState(12);
    const [sortBy, setSortBy] = useState('newest');
    const [filterBy, setFilterBy] = useState('all');
    const [searchQuery, setSearchQuery] = useState('');
    const [featuredIndex, setFeaturedIndex] = useState(0);

    // Ensure listings on cold entry
    useEffect(() => {
        if (!isInitialized && typeof fetchListings === 'function') {
            fetchListings().catch(() => { });
        }
    }, [isInitialized, fetchListings]);

    // Enhanced collection metadata resolution
    useEffect(() => {
        let cancelled = false;
        (async () => {
            if (!provider || !isAddress(addr)) {
                setCollectionData({ name: '', symbol: '', totalSupply: 0, loading: false });
                return;
            }
            setCollectionData(prev => ({ ...prev, loading: true }));
            try {
                const contract = new ethers.Contract(addr, ERC721_METADATA_ABI, provider);
                
                const [name, symbol, totalSupply] = await Promise.allSettled([
                    contract.name(),
                    contract.symbol(),
                    contract.totalSupply().catch(() => 0)
                ]);

                if (!cancelled) {
                    setCollectionData({
                        name: name.status === 'fulfilled' ? name.value?.trim() || '' : '',
                        symbol: symbol.status === 'fulfilled' ? symbol.value?.trim() || '' : '',
                        totalSupply: totalSupply.status === 'fulfilled' ? Number(totalSupply.value || 0) : 0,
                        loading: false
                    });
                }
            } catch (error) {
                console.warn('Failed to load collection metadata:', error);
                if (!cancelled) {
                    setCollectionData({ name: '', symbol: '', totalSupply: 0, loading: false });
                }
            }
        })();
        return () => { cancelled = true; };
    }, [addr, provider]);

    // Filter and sort items
    const filteredItems = useMemo(() => {
        if (!Array.isArray(listings)) return [];
        let items = listings.filter((l) => (l?.nftContract || '').toLowerCase() === addr);

        // Apply search filter
        if (searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            items = items.filter(item => 
                item.tokenId?.toString().includes(query) ||
                item.metadata?.name?.toLowerCase().includes(query) ||
                item.metadata?.description?.toLowerCase().includes(query)
            );
        }

        // Apply price filter
        if (filterBy !== 'all') {
            items = items.filter(item => {
                const price = parseFloat(ethers.formatEther(item.price || '0'));
                switch (filterBy) {
                    case 'under1': return price < 1;
                    case '1to10': return price >= 1 && price <= 10;
                    case 'over10': return price > 10;
                    default: return true;
                }
            });
        }

        // Apply sorting
        items.sort((a, b) => {
            switch (sortBy) {
                case 'price-low': {
                    const priceA = parseFloat(ethers.formatEther(a.price || '0'));
                    const priceB = parseFloat(ethers.formatEther(b.price || '0'));
                    return priceA - priceB;
                }
                case 'price-high': {
                    const priceA = parseFloat(ethers.formatEther(a.price || '0'));
                    const priceB = parseFloat(ethers.formatEther(b.price || '0'));
                    return priceB - priceA;
                }
                case 'oldest':
                    return (a.listingTime || 0) - (b.listingTime || 0);
                case 'newest':
                default:
                    return (b.listingTime || 0) - (a.listingTime || 0);
            }
        });

        return items;
    }, [listings, addr, searchQuery, filterBy, sortBy]);

    // Calculate collection stats
    const collectionStats = useMemo(() => {
        const items = filteredItems;
        const totalListings = items.length;
        
        if (totalListings === 0) {
            return {
                totalListings: 0,
                floorPrice: '$0.00',
                totalVolume: '$0.00',
                owners: 0
            };
        }

        const prices = items.map(item => parseFloat(ethers.formatEther(item.price || '0')));
        const floorPrice = Math.min(...prices);
        const totalVolume = prices.reduce((sum, price) => sum + price, 0);
        const owners = new Set(items.map(item => item.seller)).size;

        return {
            totalListings,
            floorPrice: formatPrice(ethers.parseEther(floorPrice.toString())),
            totalVolume: `$${totalVolume.toFixed(3)}`,
            owners
        };
    }, [filteredItems]);

    // Pagination
    const totalPages = Math.ceil(filteredItems.length / itemsPerPage);
    const startIndex = (currentPage - 1) * itemsPerPage;
    const paginatedItems = filteredItems.slice(startIndex, startIndex + itemsPerPage);

    // Featured carousel handlers
    const featuredItems = filteredItems.slice(0, 8); // Show up to 8 featured items
    const itemsPerView = 3;
    const maxFeaturedIndex = Math.max(0, featuredItems.length - itemsPerView);

    const nextFeatured = useCallback(() => {
        setFeaturedIndex(prev => Math.min(prev + 1, maxFeaturedIndex));
    }, [maxFeaturedIndex]);

    const prevFeatured = useCallback(() => {
        setFeaturedIndex(prev => Math.max(prev - 1, 0));
    }, []);

    // Auto-cycle featured items
    useEffect(() => {
        if (featuredItems.length <= itemsPerView) return;
        
        const interval = setInterval(() => {
            setFeaturedIndex(prev => {
                const next = prev + 1;
                return next > maxFeaturedIndex ? 0 : next;
            });
        }, 5000); // Auto-cycle every 5 seconds

        return () => clearInterval(interval);
    }, [featuredItems.length, itemsPerView, maxFeaturedIndex]);

    if (!isAddress(addr)) {
        return (
            <div className="collection-page">
                <div className="enhanced-empty-state">
                    <div className="empty-state-icon">⚠️</div>
                    <h2 className="empty-state-title">Invalid Collection Address</h2>
                    <p className="empty-state-description">
                        That doesn't look like a valid contract address. Double-check the URL or explore our marketplace.
                    </p>
                    <div className="empty-state-actions">
                        <Link to="/marketplace" className="action-btn">
                            🔍 Explore Marketplace
                        </Link>
                        <Link to="/" className="action-btn secondary">
                            🏠 Go Home
                        </Link>
                    </div>
                </div>
            </div>
        );
    }

    const displayName = collectionData.name || 
                       (collectionData.symbol ? `${collectionData.symbol} Collection` : '') || 
                       shortAddr(addr);

    return (
        <div className="collection-page">
            {/* Collection Header */}
            <div className="collection-header">
                <div className="collection-header-content">
                    <div className="collection-title-section">
                        <h1 className="collection-title">
                            {collectionData.loading ? 'Loading Collection...' : displayName}
                        </h1>
                        <p className="collection-subtitle">{addr}</p>
                        {collectionData.name && collectionData.symbol && (
                            <p className="collection-description">
                                Welcome to the {collectionData.name} ({collectionData.symbol}) collection. 
                                Discover unique NFTs and trade in the neon shadows of the digital future.
                            </p>
                        )}
                        <Link to="/marketplace" className="action-btn secondary">
                            ← Back to Marketplace
                        </Link>
                    </div>

                    {/* Collection Stats */}
                    <div className="collection-stats-grid">
                        <div className="collection-stat-card">
                            <div className="collection-stat-label">Total Items</div>
                            <h3 className="collection-stat-value">
                                {collectionData.totalSupply ? formatNumber(collectionData.totalSupply) : '—'}
                            </h3>
                        </div>
                        <div className="collection-stat-card">
                            <div className="collection-stat-label">Listed</div>
                            <h3 className="collection-stat-value">{collectionStats.totalListings}</h3>
                        </div>
                        <div className="collection-stat-card">
                            <div className="collection-stat-label">Floor Price</div>
                            <h3 className="collection-stat-value">{collectionStats.floorPrice}</h3>
                        </div>
                        <div className="collection-stat-card">
                            <div className="collection-stat-label">Total Volume</div>
                            <h3 className="collection-stat-value">{collectionStats.totalVolume}</h3>
                        </div>
                    </div>
                </div>
            </div>

            {/* Featured Tokens Carousel */}
            {featuredItems.length > 0 && (
                <div className="featured-tokens-section">
                    <div className="section-header">
                        <h2 className="section-title">✨ Featured Tokens</h2>
                        <div className="carousel-controls">
                            <button 
                                className="carousel-btn" 
                                onClick={prevFeatured}
                                disabled={featuredIndex === 0}
                                aria-label="Previous featured items"
                            >
                                ←
                            </button>
                            <button 
                                className="carousel-btn" 
                                onClick={nextFeatured}
                                disabled={featuredIndex >= maxFeaturedIndex}
                                aria-label="Next featured items"
                            >
                                →
                            </button>
                        </div>
                    </div>
                    <div className="featured-carousel">
                        <div 
                            className="featured-grid" 
                            style={{ transform: `translateX(-${featuredIndex * (300 + 16)}px)` }}
                        >
                            {featuredItems.map((item) => (
                                <div key={item.id} className="featured-item">
                                    <ListingCard listing={item} />
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* Collection Filters */}
            <div className="collection-filters">
                <div className="filter-group">
                    <span className="filter-label">Search:</span>
                    <input
                        type="text"
                        placeholder="Search by name, ID, or description..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        className="search-input"
                    />
                </div>
                <div className="filter-group">
                    <span className="filter-label">Sort by:</span>
                    <select 
                        value={sortBy} 
                        onChange={(e) => setSortBy(e.target.value)}
                        className="filter-select"
                    >
                        <option value="newest">Newest Listed</option>
                        <option value="oldest">Oldest Listed</option>
                        <option value="price-low">Price: Low to High</option>
                        <option value="price-high">Price: High to Low</option>
                    </select>
                </div>
                <div className="filter-group">
                    <span className="filter-label">Price:</span>
                    <select 
                        value={filterBy} 
                        onChange={(e) => setFilterBy(e.target.value)}
                        className="filter-select"
                    >
                        <option value="all">All Prices</option>
                        <option value="under1">Under 1 VTRU</option>
                        <option value="1to10">1-10 VTRU</option>
                        <option value="over10">Over 10 VTRU</option>
                    </select>
                </div>
            </div>

            {/* Main Content */}
            {!isInitialized ? (
                <div className="collection-loading">
                    <div className="loading-spinner"></div>
                    <p className="loading-text">Loading collection items...</p>
                </div>
            ) : filteredItems.length === 0 ? (
                <div className="enhanced-empty-state">
                    <div className="empty-state-icon">🧩</div>
                    <h2 className="empty-state-title">
                        {searchQuery ? 'No items match your search' : 'No live listings for this collection'}
                    </h2>
                    <p className="empty-state-description">
                        {searchQuery ? 
                            'Try adjusting your search terms or filters to find what you\'re looking for.' :
                            'When someone lists from this contract, items will appear here. Be the first to explore this collection!'
                        }
                    </p>
                    <div className="empty-state-actions">
                        {searchQuery ? (
                            <button 
                                onClick={() => setSearchQuery('')} 
                                className="action-btn"
                            >
                                🔄 Clear Search
                            </button>
                        ) : (
                            <Link to="/marketplace" className="action-btn">
                                🔍 Explore Other NFTs
                            </Link>
                        )}
                        <Link to="/sell" className="action-btn secondary">
                            💎 List Your NFT
                        </Link>
                    </div>
                </div>
            ) : (
                <>
                    {/* Items Grid */}
                    <div className="collection-grid">
                        {paginatedItems.map((item) => (
                            <ListingCard key={item.id} listing={item} />
                        ))}
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div className="collection-pagination">
                            <button 
                                className="pagination-btn" 
                                onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
                                disabled={currentPage === 1}
                            >
                                ← Previous
                            </button>
                            
                            <span className="pagination-info">
                                Page {currentPage} of {totalPages} ({filteredItems.length} items)
                            </span>
                            
                            <button 
                                className="pagination-btn" 
                                onClick={() => setCurrentPage(prev => Math.min(totalPages, prev + 1))}
                                disabled={currentPage === totalPages}
                            >
                                Next →
                            </button>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}