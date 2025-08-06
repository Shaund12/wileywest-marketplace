import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useWallet } from './WalletContext';
import { convertToUSDCValue } from '../utils/tokenUtils';

const MarketplaceContext = createContext();

export function MarketplaceProvider({ children, marketplaceAddress, abi }) {
    const { wallet, signer, provider } = useWallet();
    const [marketplace, setMarketplace] = useState(null);
    const [listings, setListings] = useState([]);
    const [hotListings, setHotListings] = useState([]);
    const [status, setStatus] = useState('');
    const [isInitialized, setIsInitialized] = useState(false);
    const isConnectedRef = useRef(false);
    
    // New state for tracking sales and statistics
    const [salesHistory, setSalesHistory] = useState([]);
    const [canceledListings, setCanceledListings] = useState(new Set());
    const [marketplaceStats, setMarketplaceStats] = useState({
        totalSales: 0,
        actualSoldVolume: 0,
        currentListingVolume: 0,
        transactionHistory: [],
        topTokens: [],
        mostActiveSellers: []
    });

    // Load sales history from localStorage on initialization
    useEffect(() => {
        const loadPersistedData = () => {
            try {
                const savedSalesHistory = localStorage.getItem('marketplace_sales_history');
                const savedCanceledListings = localStorage.getItem('marketplace_canceled_listings');
                
                if (savedSalesHistory) {
                    const parsedHistory = JSON.parse(savedSalesHistory);
                    console.log("Loaded persisted sales history:", parsedHistory);
                    setSalesHistory(parsedHistory);
                }
                
                if (savedCanceledListings) {
                    const parsedCanceled = JSON.parse(savedCanceledListings);
                    setCanceledListings(new Set(parsedCanceled));
                }
            } catch (error) {
                console.error("Error loading persisted marketplace data:", error);
            }
        };
        
        loadPersistedData();
    }, []);

    // Persist sales history to localStorage whenever it changes
    useEffect(() => {
        if (salesHistory.length > 0) {
            try {
                localStorage.setItem('marketplace_sales_history', JSON.stringify(salesHistory));
                console.log("Persisted sales history to localStorage:", salesHistory.length, "transactions");
            } catch (error) {
                console.error("Error persisting sales history:", error);
            }
        }
    }, [salesHistory]);

    // Persist canceled listings to localStorage whenever they change
    useEffect(() => {
        if (canceledListings.size > 0) {
            try {
                const canceledArray = Array.from(canceledListings);
                localStorage.setItem('marketplace_canceled_listings', JSON.stringify(canceledArray));
            } catch (error) {
                console.error("Error persisting canceled listings:", error);
            }
        }
    }, [canceledListings]);

    // Initialize marketplace contract
    useEffect(() => {
        const initializeMarketplace = async () => {
            if (marketplaceAddress && provider) {
                try {
                    console.log("Initializing marketplace contract...");
                    const contract = new ethers.Contract(marketplaceAddress, abi, provider);
                    setMarketplace(contract);
                    setIsInitialized(true);
                    console.log("Marketplace contract initialized successfully");
                    
                    // Test network connectivity before setting up events
                    try {
                        await provider.getNetwork();
                        // Set up event listeners for sales tracking
                        setupEventListeners(contract);
                        
                        // Fetch past sales events from blockchain
                        await fetchPastSalesEvents(contract);
                    } catch (networkError) {
                        console.warn("Network connectivity issue - event listeners not set up:", networkError.message);
                        setStatus("Network connectivity issue - running in offline mode. Sales tracking unavailable.");
                        
                        // Set up demo data for testing when network is unavailable
                        setupDemoData();
                    }
                } catch (error) {
                    console.error("Error initializing marketplace contract:", error);
                    setStatus("Failed to initialize marketplace contract");
                }
            }
        };

        initializeMarketplace();
    }, [marketplaceAddress, abi, provider]);

    // Update contract with signer when wallet connects
    useEffect(() => {
        if (signer && marketplace && !isConnectedRef.current) {
            isConnectedRef.current = true;
            const connectedContract = marketplace.connect(signer);
            setMarketplace(connectedContract);
        } else if (!signer) {
            isConnectedRef.current = false;
        }
    }, [signer, marketplace]);

    // Fetch past sales events from blockchain
    const fetchPastSalesEvents = async (contract) => {
        if (!contract || !provider) return;
        
        try {
            console.log("Fetching past sales events from blockchain...");
            
            // Test network connectivity first
            try {
                await provider.getNetwork();
            } catch (networkError) {
                console.warn("Network connectivity issue - skipping past events fetch");
                return;
            }
            
            // Get the current block number
            const currentBlock = await provider.getBlockNumber();
            
            // Look back up to 10,000 blocks (approximately 1-2 days depending on block time)
            const fromBlock = Math.max(0, currentBlock - 10000);
            
            console.log(`Searching for events from block ${fromBlock} to ${currentBlock}`);
            
            // Query past NFTPurchased events
            const purchasedEvents = await contract.queryFilter(
                contract.filters.NFTPurchased(),
                fromBlock,
                currentBlock
            );
            
            console.log(`Found ${purchasedEvents.length} past purchase events`);
            
            // Query past ListingCanceled events  
            const canceledEvents = await contract.queryFilter(
                contract.filters.ListingCanceled(),
                fromBlock,
                currentBlock
            );
            
            console.log(`Found ${canceledEvents.length} past canceled events`);
            
            // Process purchase events
            const pastSales = [];
            for (const event of purchasedEvents) {
                try {
                    const block = await event.getBlock();
                    const saleData = {
                        listingId: event.args.listingId.toString(),
                        buyer: event.args.buyer,
                        quantity: event.args.quantity.toString(),
                        totalPrice: event.args.totalPrice.toString(),
                        paymentToken: event.args.paymentToken,
                        timestamp: block.timestamp * 1000, // Convert to milliseconds
                        type: 'sale',
                        blockNumber: event.blockNumber,
                        transactionHash: event.transactionHash
                    };
                    pastSales.push(saleData);
                } catch (eventError) {
                    console.warn("Error processing past sale event:", eventError);
                }
            }
            
            // Process canceled events
            const pastCanceled = new Set();
            for (const event of canceledEvents) {
                try {
                    pastCanceled.add(event.args.listingId.toString());
                } catch (eventError) {
                    console.warn("Error processing past canceled event:", eventError);
                }
            }
            
            // Merge with existing data (avoid duplicates)
            setSalesHistory(prev => {
                const existingHashes = new Set(prev.map(sale => sale.transactionHash));
                const newSales = pastSales.filter(sale => !existingHashes.has(sale.transactionHash));
                const merged = [...prev, ...newSales].sort((a, b) => b.timestamp - a.timestamp);
                console.log(`Merged sales history: ${merged.length} total transactions (${newSales.length} new from blockchain)`);
                return merged;
            });
            
            setCanceledListings(prev => {
                const merged = new Set([...prev, ...pastCanceled]);
                console.log(`Updated canceled listings: ${merged.size} total`);
                return merged;
            });
            
        } catch (error) {
            console.error("Error fetching past sales events:", error);
        }
    };

    // Set up demo data for testing/offline mode
    const setupDemoData = () => {
        console.log("Setting up demo data for offline testing");
        
        // Only set up demo data if we don't have any existing sales history
        if (salesHistory.length === 0) {
            // Create some demo sales history
            const demoSales = [
                {
                    listingId: "1",
                    buyer: "0x1234567890123456789012345678901234567890",
                    quantity: "1",
                    totalPrice: ethers.parseEther("2.5").toString(),
                    paymentToken: ethers.ZeroAddress,
                    timestamp: Date.now() - 3600000, // 1 hour ago
                    type: 'sale'
                },
                {
                    listingId: "2", 
                    buyer: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
                    quantity: "1",
                    totalPrice: ethers.parseEther("1.8").toString(),
                    paymentToken: ethers.ZeroAddress,
                    timestamp: Date.now() - 7200000, // 2 hours ago
                    type: 'sale'
                },
                {
                    listingId: "3",
                    buyer: "0x9876543210987654321098765432109876543210", 
                    quantity: "1",
                    totalPrice: ethers.parseEther("3.2").toString(),
                    paymentToken: ethers.ZeroAddress,
                    timestamp: Date.now() - 86400000, // 1 day ago
                    type: 'sale'
                }
            ];
            
            setSalesHistory(demoSales);
        }
        
        setStatus("Running in demo mode - showing sample transaction data");
    };

    // Set up event listeners for marketplace events
    const setupEventListeners = (contract) => {
        try {
            // Listen for purchases (sales)
            contract.on("NFTPurchased", async (listingId, buyer, quantity, totalPrice, paymentToken, event) => {
                console.log("NFT Purchased event:", { listingId, buyer, quantity, totalPrice, paymentToken });
                
                try {
                    // Get block information for timestamp
                    const block = await event.getBlock();
                    
                    const saleData = {
                        listingId: listingId.toString(),
                        buyer,
                        quantity: quantity.toString(),
                        totalPrice: totalPrice.toString(),
                        paymentToken,
                        timestamp: block.timestamp * 1000, // Convert to milliseconds
                        type: 'sale',
                        blockNumber: event.blockNumber,
                        transactionHash: event.transactionHash
                    };
                    
                    setSalesHistory(prev => {
                        // Check if this transaction already exists
                        const exists = prev.some(sale => sale.transactionHash === saleData.transactionHash);
                        if (exists) {
                            console.log("Sale event already recorded, skipping duplicate");
                            return prev;
                        }
                        
                        const updated = [saleData, ...prev].sort((a, b) => b.timestamp - a.timestamp);
                        console.log("Added new sale to history:", saleData);
                        console.log("Total sales history now:", updated.length, "transactions");
                        return updated;
                    });
                } catch (error) {
                    console.error("Error processing NFTPurchased event:", error);
                    // Fallback without block info
                    const saleData = {
                        listingId: listingId.toString(),
                        buyer,
                        quantity: quantity.toString(),
                        totalPrice: totalPrice.toString(),
                        paymentToken,
                        timestamp: Date.now(),
                        type: 'sale'
                    };
                    
                    setSalesHistory(prev => [saleData, ...prev]);
                }
            });

            // Listen for canceled listings
            contract.on("ListingCanceled", (listingId) => {
                console.log("Listing Canceled event:", { listingId });
                setCanceledListings(prev => new Set([...prev, listingId.toString()]));
            });

            // Listen for new listings
            contract.on("ListingCreated", (listingId, seller, nftContract, tokenId, quantity, pricePerUnit, paymentToken, isERC1155) => {
                console.log("New listing created:", { listingId, seller, nftContract });
                // Refresh listings when new ones are created
                setTimeout(fetchListings, 2000);
            });

            console.log("Event listeners set up successfully");
        } catch (error) {
            console.error("Error setting up event listeners:", error);
        }
    };

    // Calculate comprehensive marketplace statistics
    const calculateMarketplaceStats = async () => {
        if (!provider) return;

        try {
            // Test network connectivity
            try {
                await provider.getNetwork();
            } catch (networkError) {
                console.warn("Network issue - calculating stats with fallback values");
                
                // Calculate basic stats from available data without USDC conversion
                let totalNativeVolume = 0;
                for (const sale of salesHistory) {
                    try {
                        const nativeValue = parseFloat(ethers.formatEther(sale.totalPrice));
                        totalNativeVolume += nativeValue;
                    } catch (error) {
                        console.warn("Error parsing sale price:", error);
                    }
                }
                
                // Calculate listing volume in native tokens
                let currentListingVolumeNative = 0;
                const activeListings = listings.filter(listing => 
                    listing.active && !canceledListings.has(listing.id.toString())
                );
                
                for (const listing of activeListings) {
                    try {
                        const nativeValue = parseFloat(ethers.formatEther(listing.pricePerUnit));
                        currentListingVolumeNative += nativeValue;
                    } catch (error) {
                        console.warn("Error parsing listing price:", error);
                    }
                }
                
                const transactionHistory = salesHistory.map(sale => ({
                    ...sale,
                    formattedTimestamp: new Date(sale.timestamp).toLocaleString()
                })).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);

                setMarketplaceStats({
                    totalSales: salesHistory.length,
                    actualSoldVolume: totalNativeVolume,
                    currentListingVolume: currentListingVolumeNative,
                    transactionHistory,
                    topTokens: [{ token: ethers.ZeroAddress, volume: totalNativeVolume, sales: salesHistory.length }],
                    mostActiveSellers: []
                });
                return;
            }
            
            // Calculate actual sold volume from sales history
            let actualSoldVolumeUSDC = 0;
            const topTokensMap = {};
            const sellerStatsMap = {};
            
            for (const sale of salesHistory) {
                try {
                    const usdcValue = await convertToUSDCValue(sale.totalPrice, sale.paymentToken, provider);
                    actualSoldVolumeUSDC += usdcValue;
                    
                    // Track top tokens
                    const tokenKey = sale.paymentToken || 'VTRU';
                    if (!topTokensMap[tokenKey]) {
                        topTokensMap[tokenKey] = { volume: 0, sales: 0, token: tokenKey };
                    }
                    topTokensMap[tokenKey].volume += usdcValue;
                    topTokensMap[tokenKey].sales += 1;
                } catch (error) {
                    console.warn("Error calculating sale value:", error);
                }
            }

            // Calculate current listing volume (excluding canceled listings)
            let currentListingVolumeUSDC = 0;
            const activeListings = listings.filter(listing => 
                listing.active && !canceledListings.has(listing.id.toString())
            );
            
            for (const listing of activeListings) {
                try {
                    const usdcValue = await convertToUSDCValue(listing.pricePerUnit, listing.paymentToken, provider);
                    currentListingVolumeUSDC += usdcValue;
                    
                    // Track seller stats
                    if (!sellerStatsMap[listing.seller]) {
                        sellerStatsMap[listing.seller] = { address: listing.seller, listingsCount: 0, totalVolume: 0 };
                    }
                    sellerStatsMap[listing.seller].listingsCount += 1;
                    sellerStatsMap[listing.seller].totalVolume += usdcValue;
                } catch (error) {
                    console.warn("Error calculating listing value:", error);
                }
            }

            // Process transaction history
            const transactionHistory = salesHistory.map(sale => ({
                ...sale,
                formattedTimestamp: new Date(sale.timestamp).toLocaleString()
            })).sort((a, b) => b.timestamp - a.timestamp).slice(0, 50); // Last 50 transactions

            // Get top tokens sorted by volume
            const topTokens = Object.values(topTokensMap)
                .sort((a, b) => b.volume - a.volume)
                .slice(0, 10);

            // Get most active sellers
            const mostActiveSellers = Object.values(sellerStatsMap)
                .sort((a, b) => b.listingsCount - a.listingsCount)
                .slice(0, 10);

            setMarketplaceStats({
                totalSales: salesHistory.length,
                actualSoldVolume: actualSoldVolumeUSDC,
                currentListingVolume: currentListingVolumeUSDC,
                transactionHistory,
                topTokens,
                mostActiveSellers
            });

        } catch (error) {
            console.error("Error calculating marketplace stats:", error);
        }
    };

    // Recalculate stats when data changes
    useEffect(() => {
        calculateMarketplaceStats();
    }, [salesHistory, listings, canceledListings, provider]);

    const fetchListings = async () => {
        if (!marketplace) {
            console.warn("Marketplace contract not initialized yet");
            return;
        }
        
        setStatus('Fetching listings...');
        try {
            console.log("Fetching marketplace listings...");
            
            // Test network connectivity first
            try {
                await provider.getNetwork();
            } catch (networkError) {
                console.warn("Network connectivity issue:", networkError.message);
                setStatus("Network connectivity issue - unable to fetch current listings");
                
                // Provide demo listings for testing
                const demoListings = [
                    {
                        id: 1,
                        seller: "0x1234567890123456789012345678901234567890",
                        nftContract: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
                        tokenId: "1",
                        quantity: "1",
                        pricePerUnit: ethers.parseEther("1.5").toString(),
                        paymentToken: ethers.ZeroAddress,
                        isERC1155: false,
                        active: true,
                        image: '/placeholders/nft-placeholder.jpg',
                        imageUrl: '/placeholders/nft-placeholder.jpg',
                        name: 'Demo NFT #1',
                        title: 'Demo NFT #1',
                        description: 'Demo listing for offline testing',
                        metadata: {
                            name: 'Demo NFT #1',
                            description: 'Demo listing for offline testing',
                            image: '/placeholders/nft-placeholder.jpg'
                        }
                    },
                    {
                        id: 2,
                        seller: "0x9876543210987654321098765432109876543210",
                        nftContract: "0xfedcbafedcbafedcbafedcbafedcbafedcbafed",
                        tokenId: "2",
                        quantity: "1", 
                        pricePerUnit: ethers.parseEther("2.0").toString(),
                        paymentToken: ethers.ZeroAddress,
                        isERC1155: false,
                        active: true,
                        image: '/placeholders/nft-placeholder.jpg',
                        imageUrl: '/placeholders/nft-placeholder.jpg',
                        name: 'Demo NFT #2',
                        title: 'Demo NFT #2',
                        description: 'Demo listing for offline testing',
                        metadata: {
                            name: 'Demo NFT #2',
                            description: 'Demo listing for offline testing',
                            image: '/placeholders/nft-placeholder.jpg'
                        }
                    }
                ];
                
                console.log("Using demo listings for offline testing");
                setListings(demoListings);
                setHotListings(demoListings);
                setStatus('Running in demo mode - showing sample listings');
                return;
            }
            
            const res = [];
            for (let i = 1; i < 20; i++) {
                try {
                    const listing = await marketplace.listings(i);

                    // Skip inactive listings
                    if (!listing || !listing.active) continue;

                    // Create a proper image URL for the NFT
                    let image = '/placeholders/nft-placeholder.jpg';
                    let name = `NFT #${listing.tokenId?.toString() || '0'}`;
                    let metadata = null;

                    try {
                        // Create contract instance for the NFT
                        const nftContract = new ethers.Contract(
                            listing.nftContract,
                            listing.isERC1155 ?
                                ['function uri(uint256 id) view returns (string)'] :
                                ['function tokenURI(uint256 tokenId) view returns (string)', 'function name() view returns (string)'],
                            provider
                        );

                        // Get token URI
                        let tokenURI;
                        if (listing.isERC1155) {
                            tokenURI = await nftContract.uri(listing.tokenId);
                            tokenURI = tokenURI.replace('{id}', listing.tokenId.toString().padStart(64, '0'));
                        } else {
                            tokenURI = await nftContract.tokenURI(listing.tokenId);
                        }

                        console.log(`Token URI for listing ${i}: ${tokenURI}`);

                        // Resolve IPFS URI
                        const resolvedURI = tokenURI.startsWith('ipfs://')
                            ? tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/')
                            : tokenURI;

                        // Fetch metadata
                        const response = await fetch(resolvedURI);
                        const metadataJson = await response.json();
                        metadata = metadataJson; // Save the full metadata object

                        console.log(`Metadata for listing ${i}:`, metadata);

                        if (metadata.name) name = metadata.name;

                        if (metadata.image) {
                            if (metadata.image.startsWith('ipfs://')) {
                                image = metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/');
                            } else {
                                image = metadata.image;
                            }
                            console.log(`Image URL for listing ${i}: ${image}`);
                        }
                    } catch (error) {
                        console.warn(`Failed to fetch metadata for listing ${i}:`, error);
                    }

                    // Create the sanitized listing object
                    const sanitizedListing = {
                        id: i,
                        seller: listing.seller || ethers.ZeroAddress,
                        nftContract: listing.nftContract || ethers.ZeroAddress,
                        tokenId: listing.tokenId?.toString() || '0',
                        quantity: listing.quantity?.toString() || '0',
                        pricePerUnit: listing.pricePerUnit?.toString() || '0',
                        paymentToken: listing.paymentToken || ethers.ZeroAddress,
                        isERC1155: !!listing.isERC1155,
                        active: !!listing.active,

                        // CRITICAL: Add both direct properties AND a nested metadata object
                        // This ensures we cover both access patterns
                        image,
                        imageUrl: image,
                        name,
                        title: name,
                        description: `Token ID: ${listing.tokenId?.toString() || '0'}`,

                        // Add the full metadata object - CRUCIAL!
                        // ListingCard is likely expecting this structure
                        metadata: {
                            ...metadata,
                            image: image // Ensure the IPFS URL is resolved in the metadata object too
                        }
                    };

                    console.log("Sanitized listing with image:", sanitizedListing);
                    res.push(sanitizedListing);
                } catch (err) {
                    console.log(`Skipping listing ${i}:`, err.message);
                }
            }

            console.log(`Successfully loaded ${res.length} listings`);
            setListings(res);
            setHotListings(res.slice(0, 5));
            setStatus('');
        } catch (error) {
            console.error("Error in fetchListings:", error);
            setStatus('Failed to fetch listings - network connectivity issue');
        }
    };

    // Add this ERC20 ABI at the top with your other imports
const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)'
];

// ERC721 ABI for approval operations
const ERC721_APPROVAL_ABI = [
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function getApproved(uint256 tokenId) view returns (address)',
    'function setApprovalForAll(address operator, bool approved)'
];

// ERC1155 ABI for approval operations  
const ERC1155_APPROVAL_ABI = [
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)'
];

    // Replace the current buyListing function with this version
    const buyListing = async (id, pricePerUnit, paymentToken) => {
        if (!signer) {
            setStatus('Error: Wallet not connected. Please connect your wallet first');
            return;
        }

        if (!marketplace) {
            setStatus('Error: Marketplace contract not initialized');
            return;
        }

        try {
            // Connect with signer
            const marketplaceWithSigner = marketplace.connect(signer);
            
            // If using ERC20 token (not native VTRU), check approval first
            if (paymentToken !== ethers.ZeroAddress) {
                setStatus('Checking token approval...');
                
                // Create token contract instance
                const tokenContract = new ethers.Contract(paymentToken, ERC20_ABI, signer);
                
                try {
                    // Get token symbol and decimals for better messages
                    const tokenSymbol = await tokenContract.symbol();
                    
                    // Check current allowance
                    const currentAllowance = await tokenContract.allowance(wallet, marketplaceAddress);
                    
                    // If allowance is insufficient, request approval
                    if (currentAllowance < pricePerUnit) {
                        setStatus(`Requesting approval to spend ${tokenSymbol}...`);
                        
                        // Request approval for a large amount to avoid future approvals
                        const approvalTx = await tokenContract.approve(
                            marketplaceAddress,
                            ethers.MaxUint256 // Infinite approval
                        );
                        
                        setStatus(`Approving ${tokenSymbol} spending. Please confirm in your wallet...`);
                        await approvalTx.wait();
                        setStatus(`${tokenSymbol} approved! Processing purchase...`);
                    }
                } catch (error) {
                    if (error.message.includes('user rejected')) {
                        setStatus('Token approval was rejected');
                        return;
                    }
                    console.error('Error in token approval:', error);
                    throw new Error(`Failed to approve token: ${error.message}`);
                }
            }

            // Now proceed with the purchase
            setStatus('Buying...');
            
            console.log(`Buying listing ${id} for ${ethers.formatEther(pricePerUnit)} ${
                paymentToken === ethers.ZeroAddress ? 'VTRU' : 'tokens'}`);
            
            const tx = await marketplaceWithSigner.buy(id, 1, {
                value: paymentToken === ethers.ZeroAddress ? pricePerUnit : undefined
            });
            
            setStatus('Transaction submitted. Waiting for confirmation...');
            await tx.wait();
            setStatus('Purchase successful! Updating marketplace data...');
            
            // Refresh listings and fetch any new events
            fetchListings();
            
            // Wait a moment for events to be mined and then fetch recent events
            setTimeout(async () => {
                try {
                    await fetchPastSalesEvents(marketplace);
                    setStatus('Purchase successful! Marketplace updated.');
                    
                    // Clear status after a few seconds
                    setTimeout(() => setStatus(''), 3000);
                } catch (eventError) {
                    console.warn("Error fetching updated events after purchase:", eventError);
                    setStatus('Purchase successful!');
                    setTimeout(() => setStatus(''), 3000);
                }
            }, 2000);
            
        } catch (e) {
            console.error('Error in buyListing:', e);
            
            if (e.message.includes('user rejected transaction')) {
                setStatus('Transaction was rejected in your wallet');
            } else if (e.message.includes('insufficient funds')) {
                setStatus('Error: Insufficient funds for this purchase');
            } else if (e.message.includes('caller is not token owner or approved')) {
                setStatus('Error: Seller needs to approve the marketplace to transfer their NFT');
            } else {
                setStatus('Buy failed: ' + (e.message || e));
            }
        }
    };

    const createListing = async (nftContract, tokenId, quantity, price, paymentToken) => {
        try {
            if (!signer) {
                setStatus("Error: Wallet not connected. Please connect your wallet first");
                return;
            }

            if (!marketplace) {
                throw new Error("Marketplace contract not initialized");
            }

            setStatus("Preparing listing...");
            console.log("Creating listing with parameters:", {
                nftContract,
                tokenId,
                quantity,
                price,
                paymentToken
            });

            // Check if this is an ERC721 or ERC1155
            let isERC1155 = false;
            try {
                // Try to detect if it's ERC1155 by calling balanceOf with tokenId parameter
                const testContract = new ethers.Contract(
                    nftContract,
                    ['function balanceOf(address, uint256) view returns (uint256)'],
                    provider
                );
                await testContract.balanceOf(wallet, tokenId);
                isERC1155 = true;
                console.log(`Detected ${nftContract} as ERC1155`);
            } catch (e) {
                // If that fails, assume it's ERC721
                console.log(`Detected ${nftContract} as ERC721`);
                isERC1155 = false;
            }

            // Check and request NFT approval
            if (isERC1155) {
                // Handle ERC1155 approval
                const nftContract1155 = new ethers.Contract(nftContract, ERC1155_APPROVAL_ABI, signer);

                // Check if already approved
                const isApproved = await nftContract1155.isApprovedForAll(wallet, marketplaceAddress);

                if (!isApproved) {
                    setStatus("Requesting approval to sell your NFTs...");
                    console.log("Requesting ERC1155 approval for marketplace");

                    const approvalTx = await nftContract1155.setApprovalForAll(marketplaceAddress, true);

                    setStatus("Approval transaction submitted. Please wait for confirmation...");
                    await approvalTx.wait();
                    setStatus("Approval confirmed! Creating listing...");
                }
            } else {
                // Handle ERC721 approval
                const nftContract721 = new ethers.Contract(nftContract, ERC721_APPROVAL_ABI, signer);

                // Check if already approved for all tokens
                const isApprovedForAll = await nftContract721.isApprovedForAll(wallet, marketplaceAddress);

                if (!isApprovedForAll) {
                    // Check individual token approval
                    const approvedAddress = await nftContract721.getApproved(tokenId);
                    const isTokenApproved = approvedAddress.toLowerCase() === marketplaceAddress.toLowerCase();

                    if (!isTokenApproved) {
                        setStatus("Requesting approval to sell your NFT...");
                        console.log("Requesting ERC721 approval for marketplace");

                        // Use setApprovalForAll for convenience (approves all tokens)
                        const approvalTx = await nftContract721.setApprovalForAll(marketplaceAddress, true);

                        setStatus("Approval transaction submitted. Please wait for confirmation...");
                        await approvalTx.wait();
                        setStatus("Approval confirmed! Creating listing...");
                    }
                }
            }

            // Now proceed with creating the listing
            setStatus("Creating listing...");

            // Make sure we're using the contract with the signer
            const marketplaceWithSigner = marketplace.connect(signer);

            console.log("Sending create listing transaction...");
            const tx = await marketplaceWithSigner.createListing(
                nftContract,
                tokenId,
                quantity,
                price,
                paymentToken
            );

            setStatus("Transaction submitted. Waiting for confirmation...");
            await tx.wait();
            setStatus("Listing created successfully!");

            // Refresh listings
            fetchListings();

        } catch (error) {
            console.error("Error in createListing:", error);

            // Better error handling
            if (error.message.includes("user rejected")) {
                setStatus("Transaction was rejected in your wallet");
            } else if (error.message.includes("contract runner does not support")) {
                setStatus("Error: Wallet not properly connected. Please disconnect and reconnect your wallet.");
            } else if (error.message.includes("insufficient funds")) {
                setStatus("Error: Insufficient funds for gas");
            } else {
                setStatus(`Error: ${error.message || "Failed to create listing"}`);
            }
            throw error;
        }
    };

    // Load listings on initial load
    useEffect(() => {
        if (marketplace) {
            fetchListings();
            // Use a ref to keep track of the interval
            const intervalId = setInterval(fetchListings, 30000);
            return () => clearInterval(intervalId);
        }
    }, [marketplace]);

    return (
        <MarketplaceContext.Provider value={{
            marketplace,
            marketplaceAddress,
            listings,
            hotListings,
            status,
            setStatus,
            fetchListings,
            buyListing,
            createListing,
            isInitialized,
            // New marketplace statistics and data
            salesHistory,
            canceledListings,
            marketplaceStats,
            calculateMarketplaceStats,
            // Add function to manually refresh blockchain data
            refreshBlockchainData: () => marketplace && fetchPastSalesEvents(marketplace)
        }}>
            {children}
        </MarketplaceContext.Provider>
    );
}

export function useMarketplace() {
    return useContext(MarketplaceContext);
}