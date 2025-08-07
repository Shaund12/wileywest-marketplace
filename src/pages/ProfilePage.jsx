import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { useSupabase } from '../context/SupabaseContext';
import { ethers } from 'ethers';
import ListingCard from '../components/ListingCard';
import { NFTScanner } from '../utils/nftScanner';
import '../profile-page.css';
import CacheStats from '../components/CacheStats';

// Standard ERC721 and ERC1155 minimal ABIs
const ERC721_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

const ERC1155_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
    'function uri(uint256 id) view returns (string)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
];

// List of known NFT collections to scan
const KNOWN_NFT_CONTRACTS = [
    '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906', // Pixel Ninja Cats
];

// Multiple IPFS gateways to try for better reliability
const IPFS_GATEWAYS = [

    'https://ipfs.io/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://ipfs.fleek.co/ipfs/',
    'https://dweb.link/ipfs/',
];

function ProfilePage() {
    const { wallet, connect, provider, signer, chainId } = useWallet();
    const { listings, fetchListings, status, setStatus, marketplace } = useMarketplace();
    const { 
        cacheProfileData, 
        getCachedProfile, 
        subscribeToProfiles,
        isConnected: supabaseConnected 
    } = useSupabase();
    const [activeTab, setActiveTab] = useState('myListings');
    const [userListings, setUserListings] = useState([]);
    const [userNfts, setUserNfts] = useState([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isScanning, setIsScanning] = useState(false);
    const [scanProgress, setScanProgress] = useState({ found: 0, scanned: 0, total: 0 });
    const [isListingsLoading, setIsListingsLoading] = useState(false);
    const [nftMetadata, setNftMetadata] = useState({});
    const [cancellingId, setCancellingId] = useState(null);
    const [nftFilter, setNftFilter] = useState('');
    const [contractInfo, setContractInfo] = useState({});
    const [isAdvancedSearch, setIsAdvancedSearch] = useState(false);
    const [showOnlyListable, setShowOnlyListable] = useState(false);
    const [groupByCollection, setGroupByCollection] = useState(true); // Default to grouped by collection
    const [currentView, setCurrentView] = useState('grid'); // 'grid' or 'list'
    const [selectedNft, setSelectedNft] = useState(null);
    const [showNftModal, setShowNftModal] = useState(false);
    const [showStatsModal, setShowStatsModal] = useState(false);
    const [collectionStats, setCollectionStats] = useState({});
    const [sortOption, setSortOption] = useState('default');
    const [collapsedCollections, setCollapsedCollections] = useState({});
    const [currentPage, setCurrentPage] = useState(1);
    const [itemsPerPage, setItemsPerPage] = useState(12);
    const modalRef = useRef(null);

    // Reset pagination when filters change
    useEffect(() => {
        setCurrentPage(1);
    }, [nftFilter, showOnlyListable, sortOption, groupByCollection]);

    // Calculate collection stats
    useEffect(() => {
        if (userNfts.length > 0) {
            // Group NFTs by collection
            const collections = {};
            const types = { ERC721: 0, ERC1155: 0 };
            let totalItems = userNfts.length;
            let totalQuantity = 0;

            userNfts.forEach(nft => {
                // Count by type
                types[nft.type] = (types[nft.type] || 0) + 1;

                // Count total quantity
                totalQuantity += parseInt(nft.balance || 1);

                // Group by collection
                if (!collections[nft.contractAddress]) {
                    collections[nft.contractAddress] = {
                        address: nft.contractAddress,
                        name: contractInfo[nft.contractAddress]?.name || 'Unknown Collection',
                        symbol: contractInfo[nft.contractAddress]?.symbol || '',
                        count: 0,
                        type: nft.type,
                        items: []
                    };
                }

                collections[nft.contractAddress].count++;
                collections[nft.contractAddress].items.push(nft);
            });

            setCollectionStats({
                totalItems,
                totalQuantity,
                types,
                collections: Object.values(collections).sort((a, b) => b.count - a.count)
            });
        }
    }, [userNfts, contractInfo]);

    // Filter user's active listings
    useEffect(() => {
        if (wallet && listings.length > 0) {
            const filtered = listings.filter(
                listing => listing.seller.toLowerCase() === wallet.toLowerCase()
            );
            setUserListings(filtered);
        } else {
            setUserListings([]);
        }
    }, [wallet, listings]);

    // Cancel a listing
    const cancelListing = async (listingId) => {
        if (!signer || !marketplace) return;

        try {
            setCancellingId(listingId);
            setStatus(`Cancelling listing #${listingId}...`);

            const connectedMarketplace = marketplace.connect(signer);
            const tx = await connectedMarketplace.cancelListing(listingId);
            setStatus("Transaction submitted. Waiting for confirmation...");
            await tx.wait();
            setStatus(`Listing #${listingId} cancelled successfully!`);
            fetchListings();

        } catch (error) {
            console.error("Error cancelling listing:", error);
            setStatus(`Error cancelling listing: ${error.message || error}`);
        } finally {
            setCancellingId(null);
        }
    };

    // Refresh listings manually
    // Refresh listings manually
    const refreshListings = async () => {
        setIsListingsLoading(true);
        try {
            await fetchListings();

            // Fetch metadata for all listings immediately after they're loaded
            if (listings && listings.length > 0) {
                // Create NFT objects from listings to pass to batch fetch
                const listingNfts = listings.map(listing => ({
                    contractAddress: listing.nftContract,
                    tokenId: listing.tokenId,
                    tokenURI: listing.metadata?.tokenURI || null,
                    type: listing.isERC1155 ? 'ERC1155' : 'ERC721'
                }));

                // Fetch metadata for all listings
                console.log(`Fetching metadata for ${listingNfts.length} listings...`);
                setTimeout(() => batchFetchMetadata(listingNfts), 100);
            }

            // Cache updated listings for the user
            if (supabaseConnected && cacheProfileData) {
                try {
                    const profileData = {
                        nfts: userNfts,
                        listings: userListings,
                        balance: await provider.getBalance(wallet).then(b => b.toString())
                    };

                    await cacheProfileData(wallet, profileData);
                    console.log(`✅ Cached updated profile data for ${wallet}`);
                } catch (cacheError) {
                    console.warn("Failed to cache updated profile data:", cacheError);
                }
            }

            setStatus("Listings refreshed successfully");
        } catch (error) {
            setStatus("Failed to refresh listings");
        } finally {
            setIsListingsLoading(false);
        }
    };

    // Resolve IPFS URIs for metadata and images with fallbacks
    const resolveIpfsUri = (uri) => {
        if (!uri) return '';
        if (uri.startsWith('ipfs://')) {
            // Extract the CID from the URI
            const cid = uri.replace('ipfs://', '');
            // Return the first gateway (we'll handle fallbacks in the image component)
            return `${IPFS_GATEWAYS[0]}${cid}`;
        }
        return uri;
    };

    // Generate a custom LP-style placeholder SVG for NFTs
    const generateFallbackImage = (contractAddress, tokenId) => {
        try {
            // Create deterministic values from contract+tokenId
            const hash = contractAddress.toLowerCase() + tokenId.toString();
            let hashNum = 0;
            for (let i = 0; i < hash.length; i++) {
                hashNum = ((hashNum << 5) - hashNum) + hash.charCodeAt(i);
                hashNum = hashNum & hashNum;
            }

            // Generate dynamic angles and colors
            const angle = Math.abs(hashNum % 360);
            const hue1 = Math.abs(hashNum % 360);
            const hue2 = (hue1 + 180) % 360;

            // Get collection info
            const collectionInfo = contractInfo[contractAddress] || {};
            const symbol = collectionInfo.symbol || '';
            const shortName = (symbol || collectionInfo.name || '').substring(0, 8);

            // Create an SVG that looks like an LP token with cyberpunk style
            return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'%3E%3Crect width='300' height='300' fill='%230f0f0f'/%3E%3Ccircle cx='150' cy='150' r='120' fill='none' stroke='hsl(${hue1},80%,50%)' stroke-width='2' stroke-opacity='0.3'/%3E%3Ccircle cx='150' cy='150' r='90' fill='none' stroke='hsl(${hue2},80%,60%)' stroke-width='2'/%3E%3Cpath d='M150,60 A90,90 0 0 1 ${150 + 90 * Math.cos(angle * Math.PI / 180)},${150 - 90 * Math.sin(angle * Math.PI / 180)}' stroke='hsl(${hue1},80%,60%)' stroke-width='8' fill='none'/%3E%3Cpath d='M150,60 A90,90 0 0 0 ${150 - 90 * Math.cos(angle * Math.PI / 180)},${150 - 90 * Math.sin(angle * Math.PI / 180)}' stroke='hsl(${hue2},80%,60%)' stroke-width='8' fill='none'/%3E%3Ccircle cx='150' cy='150' r='40' fill='%230f0f0f' stroke='%23ffffff' stroke-width='1' stroke-opacity='0.4'/%3E%3Ctext x='150' y='140' font-family='monospace' font-size='22' fill='%23ffffff' text-anchor='middle' font-weight='bold'%3E%23${tokenId}%3C/text%3E%3Ctext x='150' y='170' font-family='monospace' font-size='18' fill='hsl(${hue1},80%,60%)' text-anchor='middle'%3E${shortName}%3C/text%3E%3Ctext x='150' y='230' font-family='monospace' font-size='12' fill='%23ffffff' text-anchor='middle' font-weight='bold' opacity='0.7'%3EWNFT%3C/text%3E%3C/svg%3E`;
        } catch (err) {
            console.error("Error generating SVG:", err);
            // Ultra simple fallback that will definitely work
            return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect width='300' height='300' fill='%23000'/%3E%3Ctext x='150' y='150' fill='%23fff' text-anchor='middle' font-size='24'%3E%23${tokenId}%3C/text%3E%3C/svg%3E`;
        }
    };

    // Fetch NFT metadata with improved error handling and multiple retry attempts
    // Improved metadata fetching function
    const fetchNftMetadata = async (contractAddress, tokenId, tokenURI) => {
        const key = `${contractAddress.toLowerCase()}-${tokenId}`;

        // Skip if we already have metadata and it's loaded successfully
        if (nftMetadata[key]?.loaded && !nftMetadata[key]?.error) return;

        // Mark as loading
        setNftMetadata(prev => ({
            ...prev,
            [key]: {
                ...prev[key],
                loading: true,
                error: null
            }
        }));

        try {
            // If we have a tokenURI, fetch metadata
            if (tokenURI) {
                // Handle common URI formats and cleanup
                let resolvedUri = tokenURI;

                // Replace {id} with tokenId in various formats
                resolvedUri = resolvedUri.replace(/{id}/g, tokenId)
                    .replace(/{tokenId}/g, tokenId)
                    .replace(/\{id\}/g, tokenId);

                // Handle IPFS URIs
                if (resolvedUri.startsWith('ipfs://')) {
                    resolvedUri = `https://cloudflare-ipfs.com/ipfs/${resolvedUri.replace('ipfs://', '')}`;
                }

                console.log(`Fetching metadata from: ${resolvedUri}`);

                // Try to fetch with a timeout
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

                try {
                    const response = await fetch(resolvedUri, {
                        signal: controller.signal,
                        headers: {
                            'Accept': 'application/json'
                        }
                    });
                    clearTimeout(timeoutId);

                    if (response.ok) {
                        const metadata = await response.json();

                        // Process and normalize the metadata
                        let imageUrl = null;

                        // Handle various image field formats
                        if (metadata.image) {
                            imageUrl = metadata.image;

                            // Process IPFS image URLs
                            if (imageUrl.startsWith('ipfs://')) {
                                imageUrl = `https://cloudflare-ipfs.com/ipfs/${imageUrl.replace('ipfs://', '')}`;
                            }
                        } else if (metadata.image_url) {
                            imageUrl = metadata.image_url;
                        } else if (metadata.imageUrl) {
                            imageUrl = metadata.imageUrl;
                        }

                        // Try to extract attributes in various formats
                        const attributes = metadata.attributes || metadata.traits || [];

                        setNftMetadata(prev => ({
                            ...prev,
                            [key]: {
                                ...metadata,
                                imageUrl,
                                attributes,
                                loaded: true,
                                loading: false,
                                error: null
                            }
                        }));
                        return;
                    }
                } catch (fetchError) {
                    clearTimeout(timeoutId);
                    console.warn(`Error fetching from URI: ${fetchError.message}`);

                    // Try alternative IPFS gateways if needed
                    if (tokenURI.startsWith('ipfs://')) {
                        for (const gateway of IPFS_GATEWAYS) {
                            if (gateway === 'https://cloudflare-ipfs.com/ipfs/') continue; // Skip the one we already tried

                            try {
                                const altUri = `${gateway}${tokenURI.replace('ipfs://', '')}`;
                                console.log(`Trying alternative gateway: ${altUri}`);

                                const altResponse = await fetch(altUri);
                                if (altResponse.ok) {
                                    const metadata = await altResponse.json();

                                    // Process image URL
                                    let imageUrl = null;
                                    if (metadata.image) {
                                        imageUrl = metadata.image;
                                        if (imageUrl.startsWith('ipfs://')) {
                                            imageUrl = `${gateway}${imageUrl.replace('ipfs://', '')}`;
                                        }
                                    } else if (metadata.image_url) {
                                        imageUrl = metadata.image_url;
                                    }

                                    const attributes = metadata.attributes || metadata.traits || [];

                                    setNftMetadata(prev => ({
                                        ...prev,
                                        [key]: {
                                            ...metadata,
                                            imageUrl,
                                            attributes,
                                            loaded: true,
                                            loading: false,
                                            error: null
                                        }
                                    }));
                                    return;
                                }
                            } catch (e) {
                                console.warn(`Error with gateway ${gateway}: ${e.message}`);
                            }
                        }
                    }
                }
            }

            // If we reach here, use a deterministic fallback image
            const fallbackImg = generateFallbackImage(contractAddress, tokenId);

            setNftMetadata(prev => ({
                ...prev,
                [key]: {
                    name: `NFT #${tokenId}`,
                    description: 'Metadata unavailable',
                    loaded: true,
                    loading: false,
                    error: 'Could not fetch metadata',
                    imageUrl: fallbackImg,
                    attributes: []
                }
            }));

        } catch (error) {
            console.error(`Error fetching metadata for ${contractAddress} token ${tokenId}:`, error);
            const fallbackImg = generateFallbackImage(contractAddress, tokenId);

            setNftMetadata(prev => ({
                ...prev,
                [key]: {
                    name: `NFT #${tokenId}`,
                    description: 'Error loading metadata',
                    loaded: true,
                    loading: false,
                    error: error.message || 'Error loading metadata',
                    imageUrl: fallbackImg,
                    attributes: []
                }
            }));
        }
    };

    // Add this new batch fetching function
    const batchFetchMetadata = async (nfts, batchSize = 10) => {
        // Group NFTs by those that need metadata fetching
        const nftsToFetch = nfts.filter(nft => {
            const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
            return !nftMetadata[key]?.loaded && nft.tokenURI;
        });

        console.log(`Batch fetching metadata for ${nftsToFetch.length} NFTs`);

        // Process in batches to avoid overwhelming the network
        for (let i = 0; i < nftsToFetch.length; i += batchSize) {
            const batch = nftsToFetch.slice(i, i + batchSize);
            
            setStatus(`Fetching metadata ${i + 1}-${Math.min(i + batchSize, nftsToFetch.length)} of ${nftsToFetch.length}...`);
            
            // Process batch in parallel using Promise.all
            await Promise.all(
                batch.map(nft => 
                    fetchNftMetadata(nft.contractAddress, nft.tokenId, nft.tokenURI)
                        .catch(err => console.error(`Error fetching metadata for token ${nft.tokenId}:`, err))
                )
            );
            
            // Small delay between batches to be nice to IPFS gateways
            if (i + batchSize < nftsToFetch.length) {
                await new Promise(resolve => setTimeout(resolve, 300));
            }
        }
        
        if (nftsToFetch.length > 0) {
            setStatus(`Finished loading metadata for ${nftsToFetch.length} NFTs`);
        }
    };

    // Try to detect if contract is ERC721 or ERC1155
    const detectNftStandard = async (contractAddress) => {
        try {
            // First try as ERC721
            const erc721Contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
            await erc721Contract.balanceOf(wallet);
            return 'ERC721';
        } catch (e) {
            try {
                // Then try as ERC1155 with a random token ID
                const erc1155Contract = new ethers.Contract(contractAddress, ERC1155_ABI, provider);
                await erc1155Contract.balanceOf(wallet, 1);
                return 'ERC1155';
            } catch (e) {
                return null; // Not a standard NFT contract
            }
        }
    };

    // Get contract name and symbol with better error handling
    const getContractInfo = async (contractAddress, contractType) => {
        // Skip if we already have this info
        if (contractInfo[contractAddress]) return contractInfo[contractAddress];

        try {
            const abi = contractType === 'ERC721' ? ERC721_ABI : ERC1155_ABI;
            const contract = new ethers.Contract(contractAddress, abi, provider);

            let name = '';
            let symbol = '';

            try {
                name = await contract.name();
            } catch (e) {
                console.log("Contract doesn't have name function");
            }

            try {
                symbol = await contract.symbol();
            } catch (e) {
                console.log("Contract doesn't have symbol function");
            }

            // If we couldn't get a name, use a formatted address
            if (!name) {
                name = `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;
            }

            const info = { name, symbol };

            // Update state
            setContractInfo(prev => ({
                ...prev,
                [contractAddress]: info
            }));

            return info;
        } catch (e) {
            console.error("Error getting contract info:", e);
            const fallbackName = `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;

            setContractInfo(prev => ({
                ...prev,
                [contractAddress]: { name: fallbackName, symbol: '' }
            }));

            return { name: fallbackName, symbol: '' };
        }
    };

    // Scan for ERC721 NFTs owned by user
    const scanERC721 = async (contractAddress) => {
        try {
            const contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
            const balance = await contract.balanceOf(wallet);

            if (balance.toString() === '0') return [];

            // Get contract info
            await getContractInfo(contractAddress, 'ERC721');

            const nfts = [];
            const balanceNum = Number(balance.toString());

            // Update scan progress
            setScanProgress(prev => ({
                ...prev,
                total: prev.total + balanceNum
            }));

            // Process in smaller batches to avoid RPC limits
            const batchSize = 5;
            for (let batchStart = 0; batchStart < balanceNum; batchStart += batchSize) {
                const batchPromises = [];
                
                for (let i = batchStart; i < Math.min(batchStart + batchSize, balanceNum); i++) {
                    batchPromises.push((async () => {
                        try {
                            // Use tokenOfOwnerByIndex to get each token ID
                            const tokenId = await contract.tokenOfOwnerByIndex(wallet, i);
                            let tokenURI = null;

                            try {
                                tokenURI = await contract.tokenURI(tokenId);
                            } catch (e) {
                                console.log(`Error getting tokenURI for ${contractAddress} token ${tokenId}:`, e);
                            }

                            const nft = {
                                contractAddress,
                                tokenId: tokenId.toString(),
                                type: 'ERC721',
                                tokenURI,
                                balance: '1',
                            };
                            
                            nfts.push(nft);

                            // Update scan progress
                            setScanProgress(prev => ({
                                ...prev,
                                found: prev.found + 1,
                                scanned: prev.scanned + 1
                            }));
                            
                            return nft;
                        } catch (e) {
                            console.error(`Error getting token ${i} for ${contractAddress}:`, e);
                            // Update scanned count even if we failed
                            setScanProgress(prev => ({
                                ...prev,
                                scanned: prev.scanned + 1
                            }));
                            return null;
                        }
                    })());
                }
                
                // Process this batch in parallel
                await Promise.all(batchPromises);
            }
            
            // Once all NFTs are found, batch fetch their metadata
            if (nfts.length > 0) {
                // Schedule metadata fetching without waiting for it
                setTimeout(() => batchFetchMetadata(nfts), 100);
            }

            return nfts;
        } catch (e) {
            console.error(`Error scanning ERC721 contract ${contractAddress}:`, e);
            return [];
        }
    };

    // Scan for ERC1155 NFTs based on recent transfer events
    const scanERC1155 = async (contractAddress) => {
        try {
            const contract = new ethers.Contract(contractAddress, ERC1155_ABI, provider);

            // Get contract info
            await getContractInfo(contractAddress, 'ERC1155');

            // For ERC1155, we need to discover which token IDs the user owns
            // One approach is to look at Transfer events to this user
            const transferSingleFilter = contract.filters.TransferSingle(null, null, wallet);
            const transferBatchFilter = contract.filters.TransferBatch(null, null, wallet);

            // Look back from the beginning to find ALL NFTs (comprehensive scan)
            const currentBlock = await provider.getBlockNumber();
            const fromBlock = 0; // Start from beginning to find all historical NFTs

            // Get transfer events
            const singleEvents = await contract.queryFilter(transferSingleFilter, fromBlock);
            const batchEvents = await contract.queryFilter(transferBatchFilter, fromBlock);

            // Extract unique token IDs from events
            const tokenIds = new Set();

            singleEvents.forEach(event => {
                tokenIds.add(event.args.id.toString());
            });

            batchEvents.forEach(event => {
                event.args.ids.forEach(id => tokenIds.add(id.toString()));
            });

            // Add token IDs from existing listings for this contract
            listings
                .filter(l => l.nftContract.toLowerCase() === contractAddress.toLowerCase())
                .forEach(l => tokenIds.add(l.tokenId.toString()));

            // Convert to array and add some common token IDs just in case (1-10)
            for (let i = 1; i <= 10; i++) {
                tokenIds.add(i.toString());
            }

            const uniqueTokenIds = [...tokenIds];

            // Update scan progress
            setScanProgress(prev => ({
                ...prev,
                total: prev.total + uniqueTokenIds.length
            }));

            // Check balance for each token ID
            const nfts = [];

            for (const tokenId of uniqueTokenIds) {
                try {
                    const balance = await contract.balanceOf(wallet, tokenId);

                    if (balance.toString() !== '0') {
                        let tokenURI = null;
                        try {
                            tokenURI = await contract.uri(tokenId);
                        } catch (e) {
                            console.log(`Error getting URI for ${contractAddress} token ${tokenId}:`, e);
                        }

                        nfts.push({
                            contractAddress,
                            tokenId,
                            type: 'ERC1155',
                            tokenURI,
                            balance: balance.toString()
                        });

                        // Fetch metadata in background
                        fetchNftMetadata(contractAddress, tokenId, tokenURI);

                        // Update scan progress - found a token
                        setScanProgress(prev => ({
                            ...prev,
                            found: prev.found + 1
                        }));
                    }

                    // Update scan progress - scanned a token
                    setScanProgress(prev => ({
                        ...prev,
                        scanned: prev.scanned + 1
                    }));

                } catch (e) {
                    console.error(`Error checking balance for ${contractAddress} token ${tokenId}:`, e);
                    // Update scanned count even if we failed
                    setScanProgress(prev => ({
                        ...prev,
                        scanned: prev.scanned + 1
                    }));
                }
            }

            return nfts;
        } catch (e) {
            console.error(`Error scanning ERC1155 contract ${contractAddress}:`, e);
            return [];
        }
    };

    // Scan Transfer events for NFTs sent to the user
    const scanForTransferEvents = async () => {
        try {
            // Filter for all ERC721 Transfer events to the user's address
            const erc721TransferTopic = ethers.id('Transfer(address,address,uint256)');
            const toUserTopic = ethers.zeroPadValue(wallet.toLowerCase(), 32);

            // Create a filter for Transfer(*, wallet, *)
            const filter = {
                topics: [erc721TransferTopic, null, toUserTopic],
                fromBlock: -10000, // Look back ~10k blocks
                toBlock: 'latest'
            };

            // Query for the transfer events
            const logs = await provider.getLogs(filter);

            console.log(`Found ${logs.length} transfer events to user`);

            // Extract unique contract addresses
            const contracts = [...new Set(logs.map(log => log.address.toLowerCase()))];

            return contracts;
        } catch (e) {
            console.error("Error scanning for transfer events:", e);
            return [];
        }
    };

    // Find ALL NFTs owned by the user with cache-first approach and throttling
    const scanningInProgress = useRef(false);
    // Find ALL NFTs owned by the user with cache-first approach and throttling
    const findAllUserNfts = async (forceRefresh = false) => {
        if (!wallet || !provider) return;

        // Prevent multiple simultaneous scans
        if (scanningInProgress.current) {
            console.log("⏳ NFT scan already in progress, skipping...");
            return;
        }

        setIsLoading(true);
        scanningInProgress.current = true;

        try {
            // Step 1: Try to load from cache first (unless force refresh)
            if (!forceRefresh && supabaseConnected && getCachedProfile) {
                console.log("🔍 Checking cache for profile data...");
                setStatus("Loading profile from cache...");

                const cachedProfile = await getCachedProfile(wallet);

                if (cachedProfile && cachedProfile.nfts && cachedProfile.nfts.length > 0) {
                    console.log(`📦 Loaded ${cachedProfile.nfts.length} NFTs from cache`);
                    setUserNfts(cachedProfile.nfts);
                    setStatus(`Loaded ${cachedProfile.nfts.length} NFTs from cache`);

                    // Add this line to fetch metadata for cached NFTs immediately
                    console.log("🔄 Fetching metadata for cached NFTs...");
                    batchFetchMetadata(cachedProfile.nfts);

                    // Only schedule background update if no scan happened recently
                    const now = Date.now();
                    if (now - lastScanTime.current > SCAN_THROTTLE_MS) {
                        console.log("📅 Scheduling background blockchain scan...");
                        setTimeout(() => {
                            if (!scanningInProgress.current) {
                                scanUserNftsFromBlockchain(true);
                            }
                        }, 5000); // Delay background scan by 5 seconds
                    }
                    return;
                }
            }

            // Step 2: Scan from blockchain
            await scanUserNftsFromBlockchain(false);

        } catch (error) {
            console.error("Error loading user NFTs:", error);
            setStatus(`Error loading NFTs: ${error.message}`);
        } finally {
            setIsLoading(false);
            scanningInProgress.current = false;
        }
    };

    const scanUserNftsFromBlockchain = async (isBackgroundUpdate = false) => {
        // Prevent scanning if already in progress or too recent
        if (scanningInProgress.current && !isBackgroundUpdate) {
            console.log("⏳ Blockchain scan already in progress, skipping...");
            return;
        }

        const now = Date.now();
        if (isBackgroundUpdate && now - lastScanTime.current < SCAN_THROTTLE_MS) {
            console.log("⏳ Background scan throttled - too recent");
            return;
        }

        if (!isBackgroundUpdate) {
            setIsScanning(true);
            setScanProgress({ found: 0, scanned: 0, total: 0 });
            setStatus("Scanning blockchain for your NFTs...");
            scanningInProgress.current = true;
        }
        
        lastScanTime.current = now;
        
        try {
            // Create a new NFT scanner with current wallet
            const scanner = new NFTScanner(provider, wallet, (statusMsg) => {
                if (!isBackgroundUpdate) {
                    setStatus(statusMsg);
                }
            });
            
            // Start the comprehensive scan
            console.log(`${isBackgroundUpdate ? 'Background' : 'Foreground'} blockchain NFT scan starting...`);
            const foundNfts = await scanner.scanAllNFTs();
            
            // Update UI with found NFTs
            setUserNfts(foundNfts);
            
            if (isBackgroundUpdate) {
                console.log(`🔄 Background update: Found ${foundNfts.length} NFTs`);
            } else {
                setStatus(`Found ${foundNfts.length} NFTs in your wallet`);
            }
            
            // Cache the fresh data
            if (supabaseConnected && cacheProfileData && foundNfts.length > 0) {
                try {
                    const profileData = {
                        nfts: foundNfts,
                        listings: userListings,
                        balance: await provider.getBalance(wallet).then(b => b.toString())
                    };
                    
                    await cacheProfileData(wallet, profileData);
                    console.log(`✅ Cached profile data for ${wallet}`);
                } catch (cacheError) {
                    console.warn("Failed to cache profile data:", cacheError);
                }
            }
            
            // Batch fetch metadata for all NFTs
            if (foundNfts.length > 0) {
                batchFetchMetadata(foundNfts);
            }
            
            if (!isBackgroundUpdate) {
                setTimeout(() => setStatus(''), 3000);
            }
            
        } catch (error) {
            console.error("Error during NFT scan:", error);
            if (!isBackgroundUpdate) {
                setStatus(`Error scanning: ${error.message}`);
            }
        } finally {
            if (!isBackgroundUpdate) {
                setIsScanning(false);
                scanningInProgress.current = false;
            }
        }
    };

    // Toggle collection collapse state
    const toggleCollectionCollapse = (collectionAddress) => {
        setCollapsedCollections(prev => ({
            ...prev,
            [collectionAddress]: !prev[collectionAddress]
        }));
    };

    // Function to sort NFTs based on the current sort option
    const sortNfts = (nfts) => {
        if (sortOption === 'default') return nfts;

        return [...nfts].sort((a, b) => {
            const keyA = `${a.contractAddress.toLowerCase()}-${a.tokenId}`;
            const keyB = `${b.contractAddress.toLowerCase()}-${b.tokenId}`;
            const metadataA = nftMetadata[keyA] || {};
            const metadataB = nftMetadata[keyB] || {};

            switch (sortOption) {
                case 'nameAsc':
                    return (metadataA.name || `NFT #${a.tokenId}`).localeCompare(metadataB.name || `NFT #${b.tokenId}`);
                case 'nameDesc':
                    return (metadataB.name || `NFT #${b.tokenId}`).localeCompare(metadataA.name || `NFT #${a.tokenId}`);
                case 'idAsc':
                    return parseInt(a.tokenId) - parseInt(b.tokenId);
                case 'idDesc':
                    return parseInt(b.tokenId) - parseInt(a.tokenId);
                case 'collectionAsc':
                    const colA = contractInfo[a.contractAddress]?.name || a.contractAddress;
                    const colB = contractInfo[b.contractAddress]?.name || b.contractAddress;
                    return colA.localeCompare(colB);
                default:
                    return 0;
            }
        });
    };

    // Filter and sort NFTs
    const processNfts = useCallback(() => {
        // Apply filters
        let filteredNfts = userNfts.filter(nft => {
            // Text search filter
            if (nftFilter) {
                const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
                const metadata = nftMetadata[key] || {};
                const name = metadata.name || `NFT #${nft.tokenId}`;
                const contractData = contractInfo[nft.contractAddress] || {};
                const searchLower = nftFilter.toLowerCase();

                if (!(
                    name.toLowerCase().includes(searchLower) ||
                    nft.tokenId.toString().includes(searchLower) ||
                    nft.contractAddress.toLowerCase().includes(searchLower) ||
                    (contractData.name && contractData.name.toLowerCase().includes(searchLower)) ||
                    (contractData.symbol && contractData.symbol.toLowerCase().includes(searchLower))
                )) {
                    return false;
                }
            }

            // Listable filter - currently we can list all NFTs
            if (showOnlyListable) {
                // Additional logic can be added here if needed
                // For example, filtering out NFTs that don't meet certain criteria
                return true;
            }

            return true;
        });

        // Apply sorting
        filteredNfts = sortNfts(filteredNfts);

        // Group by collection if needed
        if (groupByCollection) {
            // Group NFTs by collection
            const groupedByCollection = {};

            filteredNfts.forEach(nft => {
                const collectionKey = nft.contractAddress.toLowerCase();
                if (!groupedByCollection[collectionKey]) {
                    groupedByCollection[collectionKey] = {
                        contractAddress: nft.contractAddress,
                        name: contractInfo[nft.contractAddress]?.name || `Collection ${nft.contractAddress.slice(0, 6)}...`,
                        symbol: contractInfo[nft.contractAddress]?.symbol || '',
                        items: []
                    };
                }

                groupedByCollection[collectionKey].items.push(nft);
            });

            // Sort collections by size (most NFTs first)
            return Object.values(groupedByCollection)
                .sort((a, b) => b.items.length - a.items.length);
        }

        return filteredNfts;
    }, [userNfts, nftFilter, showOnlyListable, groupByCollection, nftMetadata, contractInfo, sortOption]);

    // Get filtered and processed NFTs
    const processedNfts = processNfts();

    // Pagination logic
    const paginateItems = (items) => {
        if (!groupByCollection) {
            const startIdx = (currentPage - 1) * itemsPerPage;
            const endIdx = startIdx + itemsPerPage;
            return items.slice(startIdx, endIdx);
        }
        return items; // When grouped by collection, we'll paginate the NFTs within each collection
    };

    const paginatedItems = paginateItems(processedNfts);

    // Calculate total pages
    const totalPages = !groupByCollection
        ? Math.ceil(processedNfts.length / itemsPerPage)
        : 1; // When grouped, pagination happens within collections

    // Open the detailed NFT modal
    const openNftModal = (nft) => {
        setSelectedNft(nft);
        setShowNftModal(true);
    };

    // Close modal when clicking outside
    useEffect(() => {
        function handleClickOutside(event) {
            if (modalRef.current && !modalRef.current.contains(event.target)) {
                setShowNftModal(false);
                setShowStatsModal(false);
            }
        }

        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, [modalRef]);

    // Fetch NFTs when tab is changed to collection
    useEffect(() => {
        if (activeTab === 'collection' && wallet && !userNfts.length) {
            findAllUserNfts();
        }
    }, [activeTab, wallet]);

    // Set up real-time subscriptions for profile updates with throttling
    const lastScanTime = useRef(0);
    const SCAN_THROTTLE_MS = 30000; // Limit scans to once every 30 seconds
    
    useEffect(() => {
        if (supabaseConnected && subscribeToProfiles && wallet) {
            console.log("🔄 Setting up profile real-time subscriptions...");
            
            const profileSubscription = subscribeToProfiles((payload) => {
                console.log("📡 Real-time profile update received:", payload);
                
                // Check if the update is for the current user
                if (payload.new?.wallet_address === wallet.toLowerCase()) {
                    const now = Date.now();
                    
                    // Throttle blockchain scanning to prevent excessive calls
                    if (now - lastScanTime.current > SCAN_THROTTLE_MS) {
                        console.log("🔄 Refreshing profile due to real-time update (throttled)");
                        lastScanTime.current = now;
                        findAllUserNfts(true); // Force refresh
                    } else {
                        console.log("⏳ Profile update throttled - skipping scan (too recent)");
                    }
                }
            });

            return () => {
                if (profileSubscription) {
                    console.log("🔌 Unsubscribing from profile updates");
                    profileSubscription.unsubscribe();
                }
            };
        }
    }, [supabaseConnected, wallet]); // Removed subscribeToProfiles from dependencies

    // If wallet not connected, show connection prompt
    if (!wallet) {
        return (
            <div className="profile-container">
                <div className="profile-not-connected">
                    <h2>Connect your wallet to view your profile</h2>
                    <button className="primary-button" onClick={connect}>
                        Connect Wallet
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="profile-container">
            <div className="profile-header">
                <div className="profile-info">
                    <h1>My NFT Profile</h1>
                    <div className="wallet-display">
                        <span className="label">Wallet:</span>
                        <span className="value">{`${wallet.slice(0, 8)}...${wallet.slice(-6)}`}</span>
                    </div>
                </div>
                <div className="profile-stats">
                    <div className="stats-card" onClick={() => setShowStatsModal(true)}>
                        <div className="stats-value">{userNfts.length}</div>
                        <div className="stats-label">Total NFTs</div>
                    </div>
                    <div className="stats-card" onClick={() => setShowStatsModal(true)}>
                        <div className="stats-value">{collectionStats.collections?.length || 0}</div>
                        <div className="stats-label">Collections</div>
                    </div>
                    <div className="stats-card" onClick={() => setShowStatsModal(true)}>
                        <div className="stats-value">{userListings.length}</div>
                        <div className="stats-label">Active Listings</div>
                    </div>
                </div>
            </div>

            <div className="profile-tabs">
                <button
                    className={activeTab === 'myListings' ? 'active' : ''}
                    onClick={() => setActiveTab('myListings')}
                >
                    My Listings
                </button>
                <button
                    className={activeTab === 'activity' ? 'active' : ''}
                    onClick={() => setActiveTab('activity')}
                >
                    Activity
                </button>
                <button
                    className={activeTab === 'collection' ? 'active' : ''}
                    onClick={() => setActiveTab('collection')}
                >
                    My Collection
                </button>
            </div>

            {status && <div className="status-message">{status}</div>}

            <div className="profile-content">
                {activeTab === 'myListings' && (
                    <div className="listings-container">
                        <div className="section-header">
                            <h2>Your Active Listings</h2>
                            <button
                                className="secondary-button refresh-button"
                                onClick={refreshListings}
                                disabled={isListingsLoading}
                            >
                                {isListingsLoading ? (
                                    <><span className="spinner"></span> Refreshing...</>
                                ) : (
                                    <>Refresh Listings</>
                                )}
                            </button>
                        </div>

                        {isListingsLoading ? (
                            <div className="loading-container">
                                <div className="loading-spinner"></div>
                                <p>Loading your listings...</p>
                            </div>
                        ) : userListings.length > 0 ? (
                            <div className="listings-grid">
                                {userListings.map(listing => (
                                    <div key={listing.id} className="listing-card-container">
                                        <ListingCard listing={listing} showSeller={false} />
                                        <button
                                            className="cancel-button danger-button"
                                            onClick={() => cancelListing(listing.id)}
                                            disabled={cancellingId === listing.id}
                                        >
                                            {cancellingId === listing.id ? (
                                                <><span className="spinner"></span> Cancelling...</>
                                            ) : (
                                                <>Cancel Listing</>
                                            )}
                                        </button>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div className="empty-state">
                                <div className="empty-icon">📋</div>
                                <h3>No Active Listings</h3>
                                <p>You don't have any active listings</p>
                                <button
                                    className="primary-button"
                                    onClick={() => window.location.href = '/sell'}
                                >
                                    Create a Listing
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'activity' && (
                    <div className="activity-container">
                        <div className="section-header">
                            <h2>Recent Activity</h2>
                        </div>
                        <div className="empty-state">
                            <div className="empty-icon">📊</div>
                            <h3>No Recent Activity</h3>
                            <p>Your recent transactions will appear here</p>
                            <p className="small">We'll track your marketplace activity such as buying, selling and cancellations</p>
                        </div>
                    </div>
                )}

                {activeTab === 'collection' && (
                    <div className="collection-container">
                        <div className="section-header">
                            <h2>Your NFT Collection</h2>
                            <div className="header-actions">
                                <div className="search-container">
                                    <input
                                        type="text"
                                        placeholder="Search NFTs..."
                                        value={nftFilter}
                                        onChange={(e) => setNftFilter(e.target.value)}
                                        className="input search-input"
                                    />
                                    <button
                                        className={`view-toggle-button ${isAdvancedSearch ? 'active' : ''}`}
                                        onClick={() => setIsAdvancedSearch(!isAdvancedSearch)}
                                        title="Toggle advanced search options"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                            <path fill="currentColor" d="M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z" />
                                        </svg>
                                    </button>
                                    <div className="view-toggle">
                                        <button
                                            className={`view-toggle-button ${currentView === 'grid' ? 'active' : ''}`}
                                            onClick={() => setCurrentView('grid')}
                                            title="Grid view"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                                <path fill="currentColor" d="M3 3h8v8H3V3zm0 10h8v8H3v-8zM13 3h8v8h-8V3zm0 10h8v8h-8v-8z" />
                                            </svg>
                                        </button>
                                        <button
                                            className={`view-toggle-button ${currentView === 'list' ? 'active' : ''}`}
                                            onClick={() => setCurrentView('list')}
                                            title="List view"
                                        >
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                                <path fill="currentColor" d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" />
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                                <button
                                    className="primary-button action-button"
                                    onClick={findAllUserNfts}
                                    disabled={isLoading || isScanning}
                                >
                                    {isScanning ? (
                                        <>
                                            <span className="spinner"></span>
                                            Scanning...
                                        </>
                                    ) : (
                                        <>
                                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18">
                                                <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
                                            </svg>
                                            Find All NFTs
                                        </>
                                    )}
                                </button>
                            </div>
                        </div>

                        {isAdvancedSearch && (
                            <div className="advanced-search">
                                <div className="filter-options">
                                    <div className="filter-group">
                                        <label className="checkbox-label">
                                            <input
                                                type="checkbox"
                                                checked={showOnlyListable}
                                                onChange={() => setShowOnlyListable(!showOnlyListable)}
                                            />
                                            <span>Show only listable NFTs</span>
                                        </label>
                                        <label className="checkbox-label">
                                            <input
                                                type="checkbox"
                                                checked={groupByCollection}
                                                onChange={() => setGroupByCollection(!groupByCollection)}
                                            />
                                            <span>Group by collection</span>
                                        </label>
                                    </div>
                                    <div className="filter-group">
                                        <label htmlFor="sort-select">Sort by:</label>
                                        <select
                                            id="sort-select"
                                            value={sortOption}
                                            onChange={(e) => setSortOption(e.target.value)}
                                            className="input sort-select"
                                        >
                                            <option value="default">Default</option>
                                            <option value="nameAsc">Name (A-Z)</option>
                                            <option value="nameDesc">Name (Z-A)</option>
                                            <option value="idAsc">Token ID (Low-High)</option>
                                            <option value="idDesc">Token ID (High-Low)</option>
                                            <option value="collectionAsc">Collection</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        )}

                        {isScanning && (
                            <div className="scan-progress">
                                <div className="progress-bar">
                                    <div
                                        className="progress-fill"
                                        style={{
                                            width: `${scanProgress.total > 0 ? (scanProgress.scanned / scanProgress.total * 100) : 0}%`
                                        }}
                                    ></div>
                                </div>
                                <div className="progress-stats">
                                    <span>Found: <strong>{scanProgress.found} NFTs</strong></span>
                                    <span>Scanned: <strong>{scanProgress.scanned}/{scanProgress.total || '?'}</strong></span>
                                </div>
                                {/* Add the disclaimer here */}
                                <NFTScannerDisclaimer />
                            </div>
                        )}

                        {isLoading && !isScanning ? (
                            <div className="loading-container">
                                <div className="loading-spinner"></div>
                                <p>Loading your NFT collection...</p>
                            </div>
                        ) : groupByCollection ? (
                            // Grouped by collection view
                            <div className="collections-view">
                                {paginatedItems.length > 0 ? (
                                    paginatedItems.map((collection) => {
                                        const isCollapsed = collapsedCollections[collection.contractAddress] || false;

                                        // Paginate items within each collection
                                        const collectionStartIdx = (currentPage - 1) * itemsPerPage;
                                        const collectionEndIdx = collectionStartIdx + itemsPerPage;
                                        const paginatedCollectionItems = isCollapsed
                                            ? []
                                            : collection.items.slice(collectionStartIdx, collectionEndIdx );

                                        const totalCollectionPages = Math.ceil(collection.items.length / itemsPerPage);

                                        return (
                                            <div key={collection.contractAddress} className="collection-group card">
                                                <div
                                                    className="collection-header"
                                                    onClick={() => toggleCollectionCollapse(collection.contractAddress)}
                                                >
                                                    <div className="collection-header-left">
                                                        <span className={`collapse-icon ${isCollapsed ? 'collapsed' : ''}`}>
                                                            {isCollapsed ? '▸' : '▾'}
                                                        </span>
                                                        <h3>
                                                            {collection.name}
                                                            {collection.symbol ? ` (${collection.symbol})` : ''}
                                                        </h3>
                                                    </div>
                                                    <span className="collection-count">{collection.items.length} NFTs</span>
                                                </div>

                                                {!isCollapsed && (
                                                    <>
                                                        <div className={`nfts-${currentView}`}>
                                                            {paginatedCollectionItems.map((nft) => renderNftCard(nft))}
                                                        </div>

                                                        {totalCollectionPages > 1 && (
                                                            <div className="pagination">
                                                                <button
                                                                    onClick={() => setCurrentPage(1)}
                                                                    disabled={currentPage === 1}
                                                                    className="pagination-button"
                                                                >
                                                                    First
                                                                </button>
                                                                <button
                                                                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                                                                    disabled={currentPage === 1}
                                                                    className="pagination-button"
                                                                >
                                                                    Previous
                                                                </button>
                                                                <span className="page-info">
                                                                    Page {currentPage} of {totalCollectionPages}
                                                                </span>
                                                                <button
                                                                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalCollectionPages))}
                                                                    disabled={currentPage === totalCollectionPages}
                                                                    className="pagination-button"
                                                                >
                                                                    Next
                                                                </button>
                                                                <button
                                                                    onClick={() => setCurrentPage(totalCollectionPages)}
                                                                    disabled={currentPage === totalCollectionPages}
                                                                    className="pagination-button"
                                                                >
                                                                    Last
                                                                </button>
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        );
                                    })
                                ) : (
                                    <div className="empty-state card">
                                        <div className="empty-icon">🔍</div>
                                        <h3>No NFTs Found</h3>
                                        {nftFilter ? (
                                            <p>No NFTs found matching "{nftFilter}"</p>
                                        ) : (
                                            <>
                                                <p>No NFTs found in your wallet</p>
                                                <p className="small">Try scanning for all your NFTs</p>
                                            </>
                                        )}
                                        <button
                                            className="primary-button"
                                            onClick={findAllUserNfts}
                                            disabled={isScanning}
                                        >
                                            {isScanning ? 'Scanning...' : 'Find All NFTs'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : (
                            // Regular view
                            <div className="ungrouped-view card">
                                {userNfts.length > 0 && (
                                    <div className="collection-stats-bar">
                                        {nftFilter ? (
                                            <p>Found {processedNfts.length} of {userNfts.length} NFTs matching "{nftFilter}"</p>
                                        ) : (
                                            <p>Showing {paginatedItems.length} of {processedNfts.length} NFTs</p>
                                        )}
                                    </div>
                                )}

                                {paginatedItems.length > 0 ? (
                                    <>
                                        <div className={`nfts-${currentView}`}>
                                            {paginatedItems.map(nft => renderNftCard(nft))}
                                        </div>

                                        {totalPages > 1 && (
                                            <div className="pagination">
                                                <button
                                                    onClick={() => setCurrentPage(1)}
                                                    disabled={currentPage === 1}
                                                    className="pagination-button"
                                                >
                                                    First
                                                </button>
                                                <button
                                                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
                                                    disabled={currentPage === 1}
                                                    className="pagination-button"
                                                >
                                                    Previous
                                                </button>
                                                <span className="page-info">
                                                    Page {currentPage} of {totalPages}
                                                </span>
                                                <button
                                                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
                                                    disabled={currentPage === totalPages}
                                                    className="pagination-button"
                                                >
                                                    Next
                                                </button>
                                                <button
                                                    onClick={() => setCurrentPage(totalPages)}
                                                    disabled={currentPage === totalPages}
                                                    className="pagination-button"
                                                >
                                                    Last
                                                </button>
                                            </div>
                                        )}
                                    </>
                                ) : (
                                    <div className="empty-state">
                                        <div className="empty-icon">🔍</div>
                                        <h3>No NFTs Found</h3>
                                        {nftFilter ? (
                                            <p>No NFTs found matching "{nftFilter}"</p>
                                        ) : (
                                            <>
                                                <p>No NFTs found in your wallet</p>
                                                <p className="small">Try scanning for all your NFTs</p>
                                            </>

                                        )}
                                        <button
                                            className="primary-button"
                                            onClick={findAllUserNfts}
                                            disabled={isScanning}
                                        >
                                            {isScanning ? 'Scanning...' : 'Find All NFTs'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* NFT Detail Modal */}
            {showNftModal && selectedNft && (
                <div className="modal-overlay">
                    <div className="nft-modal card" ref={modalRef}>
                        <button className="modal-close" onClick={() => setShowNftModal(false)}>×</button>
                        <NftDetailView nft={selectedNft} metadata={nftMetadata[`${selectedNft.contractAddress.toLowerCase()}-${selectedNft.tokenId}`]} contractInfo={contractInfo[selectedNft.contractAddress]} />
                    </div>
                </div>
            )}

            {/* Collection Stats Modal */}
            {showStatsModal && (
                <div className="modal-overlay">
                    <div className="stats-modal card" ref={modalRef}>
                        <button className="modal-close" onClick={() => setShowStatsModal(false)}>×</button>
                        <div className="stats-modal-header">
                            <h2>Collection Statistics</h2>
                        </div>
                        <div className="stats-modal-content">
                            <div className="stats-summary">
                                <div className="stat-box">
                                    <div className="stat-value">{userNfts.length}</div>
                                    <div className="stat-label">Total NFTs</div>
                                </div>
                                <div className="stat-box">
                                    <div className="stat-value">{collectionStats.totalQuantity || userNfts.length}</div>
                                    <div className="stat-label">Total Quantity</div>
                                </div>
                                <div className="stat-box">
                                    <div className="stat-value">{collectionStats.collections?.length || 0}</div>
                                    <div className="stat-label">Collections</div>
                                </div>
                                <div className="stat-box">
                                    <div className="stat-value">{collectionStats.types?.ERC721 || 0}</div>
                                    <div className="stat-label">ERC721 Tokens</div>
                                </div>
                                <div className="stat-box">
                                    <div className="stat-value">{collectionStats.types?.ERC1155 || 0}</div>
                                    <div className="stat-label">ERC1155 Tokens</div>
                                </div>
                            </div>

                            <div className="collections-list">
                                <h3>Your Collections</h3>
                                <table className="collections-table">
                                    <thead>
                                        <tr>
                                            <th>Collection</th>
                                            <th>Symbol</th>
                                            <th>NFTs</th>
                                            <th>Type</th>
                                            <th>Action</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {collectionStats.collections?.map((col) => (
                                            <tr key={col.address}>
                                                <td>{col.name || 'Unknown'}</td>
                                                <td>{col.symbol || '-'}</td>
                                                <td>{col.count}</td>
                                                <td>{col.type}</td>
                                                <td>
                                                    <button
                                                        className="secondary-button small-button"
                                                        onClick={() => {
                                                            setNftFilter(col.name);
                                                            setShowStatsModal(false);
                                                            setActiveTab('collection');
                                                        }}
                                                    >
                                                        View
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );

    // Helper function to render NFT cards with appropriate layout
    function renderNftCard(nft) {
        const key = `${nft.contractAddress.toLowerCase()}-${nft.tokenId}`;
        const metadata = nftMetadata[key] || {};
        const isLoading = metadata.loading;
        const error = metadata.error;
        const fallbackImg = generateFallbackImage(nft.contractAddress, nft.tokenId);
        const imageUrl = metadata.imageUrl || fallbackImg;
        const name = metadata.name || `NFT #${nft.tokenId}`;
        const collectionInfo = contractInfo[nft.contractAddress] || {};

        if (currentView === 'grid') {
            return (
                <div key={key} className="nft-card" onClick={() => openNftModal(nft)}>
                    <div className="nft-card-inner">
                        <div className="nft-image">
                            {isLoading ? (
                                <div className="loading-image">
                                    <div className="loading-spinner small"></div>
                                </div>
                            ) : error ? (
                                <div className="error-image">
                                    <span>❌</span>
                                    <img
                                        src={fallbackImg}
                                        alt={name}
                                        className="fallback"
                                    />
                                </div>
                            ) : (
                                <img
                                    src={imageUrl}
                                    alt={name}
                                    onError={(e) => {
                                        e.target.onerror = null;
                                        e.target.src = fallbackImg;
                                        e.target.classList.add('fallback');
                                    }}
                                />
                            )}
                        </div>
                        <div className="nft-details">
                            <h3 title={name}>{name}</h3>
                            <p className="collection-name" title={collectionInfo.name || 'Unknown Collection'}>
                                {collectionInfo.name || 'Unknown Collection'}
                                {collectionInfo.symbol ? ` (${collectionInfo.symbol})` : ''}
                            </p>
                            <div className="nft-footer">
                                <div className="nft-type-badge">{nft.type}</div>
                                {nft.type === 'ERC1155' && nft.balance > 1 && (
                                    <div className="nft-quantity">×{nft.balance}</div>
                                )}
                            </div>
                        </div>
                        <div className="nft-actions">
                            <button
                                className="primary-button full-width"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    window.location.href = `/sell?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`;
                                }}
                            >
                                List for Sale
                            </button>
                        </div>
                    </div>
                </div>
            );
        } else {
            // List view
            return (
                <div key={key} className="nft-list-item">
                    <div className="nft-list-image" onClick={() => openNftModal(nft)}>
                        {isLoading ? (
                            <div className="loading-image">
                                <div className="loading-spinner small"></div>
                            </div>
                        ) : error ? (
                            <div className="error-image">
                                <span>❌</span>
                                <img
                                    src={fallbackImg}
                                    alt={name}
                                    className="fallback"
                                />
                            </div>
                        ) : (
                            <img
                                src={imageUrl}
                                alt={name}
                                onError={(e) => {
                                    e.target.onerror = null;
                                    e.target.src = fallbackImg;
                                    e.target.classList.add('fallback');
                                }}
                            />
                        )}
                    </div>
                    <div className="nft-list-details" onClick={() => openNftModal(nft)}>
                        <h3>{name}</h3>
                        <p className="collection-name">
                            {collectionInfo.name || 'Unknown Collection'}
                            {collectionInfo.symbol ? ` (${collectionInfo.symbol})` : ''}
                        </p>
                        <div className="nft-list-meta">
                            <span className="nft-type-badge">{nft.type}</span>
                            {nft.type === 'ERC1155' && nft.balance > 1 && (
                                <span className="nft-quantity">Quantity: {nft.balance}</span>
                            )}
                            <span className="token-id">ID: {nft.tokenId}</span>
                        </div>
                    </div>
                    <div className="nft-list-actions">
                        <button
                            className="primary-button"
                            onClick={() => window.location.href = `/sell?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`}
                        >
                            List for Sale
                        </button>
                        <button
                            className="secondary-button"
                            onClick={(e) => {
                                e.stopPropagation();
                                openNftModal(nft);
                            }}
                        >
                            View Details
                        </button>
                    </div>
                </div>
            );
        }
    }

    // Add this function inside ProfilePage component before the return statement
    function NFTScannerDisclaimer() {
        return (
            <div className="nft-scanner-disclaimer">
                <div className="disclaimer-header">
                    <i className="fas fa-info-circle"></i>
                    <h3>NFT Scanning Process</h3>
                </div>
                <p>Loading NFTs may take several minutes as we scan the entire blockchain history to find all your tokens. This thorough scanning ensures we find older NFTs that other viewers might miss.</p>
                <div className="tips-container">
                    <h4>Tips:</h4>
                    <ul>
                        <li>Recently acquired NFTs will appear first</li>
                        <li>Cached results will load instantly on future visits</li>
                        <li>You can continue browsing while scanning runs in the background</li>
                    </ul>
                </div>
            </div>
        );
    }
}

// NFT Detail View Component for the modal
function NftDetailView({ nft, metadata = {}, contractInfo = {} }) {
    const [activeTab, setActiveTab] = useState('details');

    if (!nft) return null;

    const name = metadata.name || `NFT #${nft.tokenId}`;
    const description = metadata.description || 'No description available';
    const attributes = metadata.attributes || [];
    const imageUrl = metadata.imageUrl || generateFallbackImage(nft.contractAddress, nft.tokenId);
    const collectionName = contractInfo.name || 'Unknown Collection';
    const collectionSymbol = contractInfo.symbol || '';

    // Helper to generate fallback image - simple but reliable version
    // Generate a custom LP-style placeholder SVG for NFTs
    const generateFallbackImage = (contractAddress, tokenId) => {
        try {
            // Create deterministic values from contract+tokenId
            const hash = contractAddress.toLowerCase() + tokenId.toString();
            let hashNum = 0;
            for (let i = 0; i < hash.length; i++) {
                hashNum = ((hashNum << 5) - hashNum) + hash.charCodeAt(i);
                hashNum = hashNum & hashNum;
            }

            // Generate dynamic angles and colors
            const angle = Math.abs(hashNum % 360);
            const hue1 = Math.abs(hashNum % 360);
            const hue2 = (hue1 + 180) % 360;

            // Get collection info
            const collectionInfo = contractInfo[contractAddress] || {};
            const symbol = collectionInfo.symbol || '';
            const shortName = (symbol || collectionInfo.name || '').substring(0, 8);

            // Create an SVG that looks like an LP token with cyberpunk style
            return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300'%3E%3Crect width='300' height='300' fill='%230f0f0f'/%3E%3Ccircle cx='150' cy='150' r='120' fill='none' stroke='hsl(${hue1},80%,50%)' stroke-width='2' stroke-opacity='0.3'/%3E%3Ccircle cx='150' cy='150' r='90' fill='none' stroke='hsl(${hue2},80%,60%)' stroke-width='2'/%3E%3Cpath d='M150,60 A90,90 0 0 1 ${150 + 90 * Math.cos(angle * Math.PI / 180)},${150 - 90 * Math.sin(angle * Math.PI / 180)}' stroke='hsl(${hue1},80%,60%)' stroke-width='8' fill='none'/%3E%3Cpath d='M150,60 A90,90 0 0 0 ${150 - 90 * Math.cos(angle * Math.PI / 180)},${150 - 90 * Math.sin(angle * Math.PI / 180)}' stroke='hsl(${hue2},80%,60%)' stroke-width='8' fill='none'/%3E%3Ccircle cx='150' cy='150' r='40' fill='%230f0f0f' stroke='%23ffffff' stroke-width='1' stroke-opacity='0.4'/%3E%3Ctext x='150' y='140' font-family='monospace' font-size='22' fill='%23ffffff' text-anchor='middle' font-weight='bold'%3E%23${tokenId}%3C/text%3E%3Ctext x='150' y='170' font-family='monospace' font-size='18' fill='hsl(${hue1},80%,60%)' text-anchor='middle'%3E${shortName}%3C/text%3E%3Ctext x='150' y='230' font-family='monospace' font-size='12' fill='%23ffffff' text-anchor='middle' font-weight='bold' opacity='0.7'%3EWNFT%3C/text%3E%3C/svg%3E`;
        } catch (err) {
            console.error("Error generating SVG:", err);
            // Ultra simple fallback that will definitely work
            return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='300' height='300'%3E%3Crect width='300' height='300' fill='%23000'/%3E%3Ctext x='150' y='150' fill='%23fff' text-anchor='middle' font-size='24'%3E%23${tokenId}%3C/text%3E%3C/svg%3E`;
        }
    };

    return (
        <div className="nft-detail-view">
            <div className="nft-detail-header">
                <h2>{name}</h2>
                <div className="collection-badge">
                    {collectionName}
                    {collectionSymbol ? ` (${collectionSymbol})` : ''}
                </div>
            </div>

            <div className="nft-detail-content">
                <div className="nft-detail-image-container">
                    <img
                        src={imageUrl}
                        alt={name}
                        className="nft-detail-image"
                        onError={(e) => {
                            e.target.onerror = null;
                            e.target.src = generateFallbackImage(nft.contractAddress, nft.tokenId);
                        }}
                    />
                    {nft.type === 'ERC1155' && nft.balance > 1 && (
                        <div className="nft-detail-quantity">
                            You own {nft.balance} of these NFTs
                        </div>
                    )}
                </div>

                <div className="nft-detail-info">
                    <div className="nft-detail-tabs">
                        <button
                            className={activeTab === 'details' ? 'active' : ''}
                            onClick={() => setActiveTab('details')}
                        >
                            Details
                        </button>
                        <button
                            className={activeTab === 'attributes' ? 'active' : ''}
                            onClick={() => setActiveTab('attributes')}
                        >
                            Attributes ({attributes.length})
                        </button>
                        <button
                            className={activeTab === 'blockchain' ? 'active' : ''}
                            onClick={() => setActiveTab('blockchain')}
                        >
                            Blockchain
                        </button>
                    </div>

                    <div className="nft-detail-tab-content">
                        {activeTab === 'details' && (
                            <div className="tab-details">
                                <h3>Description</h3>
                                <p className="nft-description">{description}</p>

                                <div className="detail-actions">
                                    <button
                                        className="primary-button"
                                        onClick={() => window.location.href = `/sell?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`}
                                    >
                                        List for Sale
                                    </button>
                                </div>
                            </div>
                        )}

                        {activeTab === 'attributes' && (
                            <div className="tab-attributes">
                                {attributes.length > 0 ? (
                                    <div className="attributes-grid">
                                        {attributes.map((attr, index) => (
                                            <div key={index} className="attribute-card">
                                                <div className="attribute-type">
                                                    {attr.trait_type || attr.name || 'Trait'}
                                                </div>
                                                <div className="attribute-value">
                                                    {attr.value?.toString() || 'Unknown'}
                                                </div>
                                                {attr.rarity_percentage && (
                                                    <div className="attribute-rarity">
                                                        {attr.rarity_percentage}% have this trait
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <p className="no-attributes">This NFT has no attributes</p>
                                )}
                            </div>
                        )}

                        {activeTab === 'blockchain' && (
                            <div className="tab-blockchain">
                                <div className="blockchain-detail">
                                    <div className="detail-label">Contract Address</div>
                                    <div className="detail-value address">
                                        <a
                                            href={`https://explorer.vitruveo.xyz/address/${nft.contractAddress}`}

                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            {nft.contractAddress}
                                        </a>
                                    </div>
                                </div>
                                <div className="blockchain-detail">
                                    <div className="detail-label">Token ID</div>
                                    <div className="detail-value">{nft.tokenId}</div>
                                </div>
                                <div className="blockchain-detail">
                                    <div className="detail-label">Token Standard</div>
                                    <div className="detail-value">{nft.type}</div>
                                </div>
                                <div className="blockchain-detail">
                                    <div className="detail-label">Token URI</div>
                                    <div className="detail-value uri">
                                        {nft.tokenURI || 'Not available'}
                                    </div>
                                </div>
                                <div className="blockchain-actions">
                                    <button
                                        className="secondary-button"
                                        onClick={() => window.open(`https://explorer.vitruveo.xyz/token/${nft.contractAddress}?a=${nft.tokenId}`, '_blank')}
                                    >
                                        View on Explorer
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ProfilePage;

// Add this function outside of the components at the top of the file, after imports
function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;

    let r, g, b;
    if (h >= 0 && h < 60) {
        [r, g, b] = [c, x, 0];
    } else if (h >= 60 && h < 120) {
        [r, g, b] = [x, c, 0];
    } else if (h >= 120 && h < 180) {
        [r, g, b] = [0, c, x];
    } else if (h >= 180 && h < 240) {
        [r, g, b] = [0, x, c];
    } else if (h >= 240 && h < 300) {
        [r, g, b] = [x, 0, c];
    } else {
        [r, g, b] = [c, 0, x];
    }

    const toHex = (c) => {
        const hex = Math.round((c + m) * 255).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    };

    return `${toHex(r)}${toHex(g)}${toHex(b)}`;
}