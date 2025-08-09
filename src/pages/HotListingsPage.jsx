import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import ListingCard from '../components/ListingCard';
import LoadingSkeleton from '../components/LoadingSkeleton';
import EmptyState from '../components/EmptyState';
import './HotListingsPage.css';
import { ethers } from 'ethers';

// Minimal ABIs to fetch collection information
const COLLECTION_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)'
];

// Interface IDs
const INTERFACE_ID_ERC721 = '0x80ac58cd';
const INTERFACE_ID_ERC1155 = '0xd9b67a26';

// Simplified particle generation with fewer particles
const createParticles = (canvas) => {
    if (!canvas) return null;

    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // Reduced particles for cleaner look
    const particles = [];
    const particleCount = 50;
    const colors = ['#ff3366', '#5533ff', '#33ccff'];

    for (let i = 0; i < particleCount; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            radius: Math.random() * 2 + 0.5,
            color: colors[Math.floor(Math.random() * colors.length)],
            velocity: {
                x: Math.random() * 1 - 0.5,
                y: Math.random() * 1 - 0.5
            },
            opacity: Math.random() * 0.4 + 0.1
        });
    }

    const animate = () => {
        requestAnimationFrame(animate);
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        particles.forEach(particle => {
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
            ctx.fillStyle = particle.color + Math.floor(particle.opacity * 100).toString(16);
            ctx.fill();

            particle.x += particle.velocity.x;
            particle.y += particle.velocity.y;

            if (particle.x < 0) particle.x = canvas.width;
            if (particle.x > canvas.width) particle.x = 0;
            if (particle.y < 0) particle.y = canvas.height;
            if (particle.y > canvas.height) particle.y = 0;
        });
    };

    animate();

    const handleResize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
};

// Collection details cache to avoid duplicate requests
const collectionDetailsCache = {};

function HotListingsPage() {
    const { hotListings, fetchListings } = useMarketplace();
    const { provider } = useWallet();
    const particleCanvas = useRef(null);
    const cardsContainer = useRef(null);
    const [groupedListings, setGroupedListings] = useState({});
    const [collectionOrder, setCollectionOrder] = useState([]);
    const [collectionsLoading, setCollectionsLoading] = useState(true);
    const [hasInitiallyFetched, setHasInitiallyFetched] = useState(false);
    const fetchInProgress = useRef(false);

    // Initialize particles
    useEffect(() => {
        const cleanup = createParticles(particleCanvas.current);
        return cleanup;
    }, []);

    // Fetch listings only once on mount
    useEffect(() => {
        if (!hasInitiallyFetched && !fetchInProgress.current) {
            fetchInProgress.current = true;
            fetchListings().then(() => {
                fetchInProgress.current = false;
                setHasInitiallyFetched(true);
            });
        }
    }, [fetchListings, hasInitiallyFetched]);

    // Function to fetch collection details from contract (memoized to avoid recreating)
    const fetchCollectionDetails = useCallback(async (contractAddress) => {
        // Return from cache if available
        if (collectionDetailsCache[contractAddress]) {
            return collectionDetailsCache[contractAddress];
        }

        try {
            // Create a contract instance with the collection ABI
            const contract = new ethers.Contract(contractAddress, COLLECTION_ABI, provider);

            // Check if contract supports ERC721 or ERC1155 interface
            let contractType = 'Unknown';
            let isERC721 = false;
            let isERC1155 = false;

            try {
                isERC721 = await contract.supportsInterface(INTERFACE_ID_ERC721);
                contractType = isERC721 ? 'ERC721' : contractType;
            } catch (e) {
                // Silently handle error
            }

            if (!isERC721) {
                try {
                    isERC1155 = await contract.supportsInterface(INTERFACE_ID_ERC1155);
                    contractType = isERC1155 ? 'ERC1155' : contractType;
                } catch (e) {
                    // Silently handle error
                }
            }

            // Get collection name and symbol
            let name = '';
            let symbol = '';

            try {
                name = await contract.name();
            } catch (e) {
                name = `Collection ${contractAddress.substring(0, 6)}...${contractAddress.substring(38)}`;
            }

            try {
                symbol = await contract.symbol();
            } catch (e) {
                symbol = '';
            }

            const details = {
                name,
                symbol,
                type: contractType
            };

            // Cache the result
            collectionDetailsCache[contractAddress] = details;
            return details;
        } catch (e) {
            console.error(`Error fetching collection details for ${contractAddress}:`, e);
            // Return fallback data
            return {
                name: `Collection ${contractAddress.substring(0, 6)}...`,
                symbol: '',
                type: 'Unknown'
            };
        }
    }, [provider]);

    // Track if we need to fetch collection details
    const [needsFetch, setNeedsFetch] = useState(false);
    
    // Track when hotListings updates
    useEffect(() => {
        if (hotListings?.length > 0 && provider && hasInitiallyFetched) {
            setNeedsFetch(true);
        }
    }, [hotListings, provider, hasInitiallyFetched]);
    
    // Group listings by collection with enhanced details
    useEffect(() => {
        // Only proceed if we need to fetch and have the necessary data
        if (!needsFetch || !hotListings?.length || !provider) return;
        
        // Prevent repeated fetches
        setNeedsFetch(false);
        
        const fetchAndGroupListings = async () => {
            setCollectionsLoading(true);
            
            try {
                const grouped = {};
                const order = [];
                const contractsToFetch = new Set();

                // First identify all unique contracts
                hotListings.forEach(listing => {
                    contractsToFetch.add(listing.nftContract);
                });

                // Fetch all collection details in parallel
                const contractsArray = Array.from(contractsToFetch);
                const detailsPromises = contractsArray.map(addr =>
                    fetchCollectionDetails(addr)
                );

                // Wait for all collection details to load
                const detailsResults = await Promise.allSettled(detailsPromises);

                // Map contract addresses to their details
                const contractDetails = {};
                contractsArray.forEach((addr, index) => {
                    if (detailsResults[index].status === 'fulfilled') {
                        contractDetails[addr] = detailsResults[index].value;
                    } else {
                        contractDetails[addr] = {
                            name: `Collection ${addr.substring(0, 6)}...`,
                            symbol: '',
                            type: 'Unknown'
                        };
                    }
                });

                // Group listings using the fetched details
                hotListings.forEach(listing => {
                    const collectionAddr = listing.nftContract;
                    const details = contractDetails[collectionAddr];

                    if (!grouped[collectionAddr]) {
                        grouped[collectionAddr] = {
                            name: details.name,
                            symbol: details.symbol,
                            type: details.type,
                            address: collectionAddr,
                            items: []
                        };
                        order.push(collectionAddr);
                    }

                    grouped[collectionAddr].items.push(listing);
                });

                // Sort collections by item count (descending)
                order.sort((a, b) => grouped[b].items.length - grouped[a].items.length);

                setGroupedListings(grouped);
                setCollectionOrder(order);
            } catch (error) {
                console.error("Error grouping listings:", error);
            } finally {
                setCollectionsLoading(false);
            }
        };

        fetchAndGroupListings();
    }, [hotListings, provider, needsFetch, fetchCollectionDetails]);

    // Render a collection section with enhanced details
    const renderCollectionSection = (collectionAddr, collection) => {
        return (
            <div key={collectionAddr} className="collection-section">
                <div className="collection-header">
                    <div className="collection-header-left">
                        <h2>{collection.name}</h2>
                        {collection.symbol && (
                            <span className="collection-symbol">{collection.symbol}</span>
                        )}
                        {collection.type !== 'Unknown' && (
                            <span className="collection-type">{collection.type}</span>
                        )}
                    </div>
                    <span className="collection-count">{collection.items.length} items</span>
                </div>

                <div className="listings-grid featured">
                    {collection.items.map((listing, index) => renderListingCard(listing, index))}
                </div>
            </div>
        );
    };

    // Function to render enhanced listing card
    const renderListingCard = (listing, index) => {
        // Use a collection-specific badge if this is a known collection
        const collection = groupedListings[listing.nftContract];
        const badgeLabel = collection?.symbol || "Featured";

        return (
            <div
                key={listing.id}
                className="listing-wrapper"
                style={{ '--item-index': index }}
            >
                {/* Collection-branded hot badge */}
                <div className="hot-badge">
                    <span className="fire-emoji">🔥</span> {badgeLabel}
                </div>

                <ListingCard
                    listing={listing}
                    featured={true}
                />
            </div>
        );
    };

    return (
        <div className="hot-listings-container organized">
            {/* Subtle particle background */}
            <canvas ref={particleCanvas} className="particles-bg"></canvas>

            {/* Premium header */}
            <div className="page-header">
                <h1>
                    <span className="fire-emoji">🔥</span> Premium Listings
                </h1>
                <p>Curated collections of exclusive digital assets from verified creators</p>
            </div>

            {/* Collections view */}
            <div className="collections-container" ref={cardsContainer}>
                {collectionsLoading ? (
                    <LoadingSkeleton 
                        type="card" 
                        count={6} 
                        className="grid"
                    />
                ) : collectionOrder.length > 0 ? (
                    collectionOrder.map(addr =>
                        renderCollectionSection(addr, groupedListings[addr])
                    )
                ) : (
                    <EmptyState
                        icon="🔥"
                        title="No Premium Listings Yet"
                        description="Premium collections will appear here when they become available. Be the first to discover exclusive NFT drops!"
                        actionText="Explore Marketplace"
                        onAction={() => window.location.href = '/marketplace'}
                        secondaryActionText="List Your NFT"
                        onSecondaryAction={() => window.location.href = '/sell'}
                    />
                )}
            </div>
        </div>
    );
}

export default HotListingsPage;