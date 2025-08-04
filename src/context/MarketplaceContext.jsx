import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useWallet } from './WalletContext';

const MarketplaceContext = createContext();

export function MarketplaceProvider({ children, marketplaceAddress, abi }) {
    const { wallet, signer, provider } = useWallet();
    const [marketplace, setMarketplace] = useState(null);
    const [listings, setListings] = useState([]);
    const [hotListings, setHotListings] = useState([]);
    const [status, setStatus] = useState('');
    const isConnectedRef = useRef(false);

    // Initialize marketplace contract
    useEffect(() => {
        if (marketplaceAddress && provider) {
            const contract = new ethers.Contract(marketplaceAddress, abi, provider);
            setMarketplace(contract);
        }
    }, [marketplaceAddress, abi]);

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

    const fetchListings = async () => {
        if (!marketplace) return;
        setStatus('Fetching listings...');
        try {
            const res = [];
            for (let i = 1; i < 20; i++) {
                try {
                    const listing = await marketplace.listings(i);

                    // Make sure the listing exists and is active
                    if (listing && listing.active) {
                        // Ensure all fields have valid values to prevent errors in ListingCard
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
                            // Add metadata placeholders
                            metadata: null,
                            imageUrl: null,
                            name: `NFT #${listing.tokenId?.toString()}`
                        };

                        // Fetch NFT metadata to get the actual image
                        try {
                            // Create contract instance for the NFT
                            const nftContract = new ethers.Contract(
                                listing.nftContract,
                                // Use appropriate ABI based on token type
                                listing.isERC1155 ?
                                    ['function uri(uint256 id) view returns (string)'] :
                                    ['function tokenURI(uint256 tokenId) view returns (string)'],
                                provider
                            );

                            // Get token URI
                            const tokenURI = listing.isERC1155 ?
                                await nftContract.uri(listing.tokenId) :
                                await nftContract.tokenURI(listing.tokenId);

                            // Resolve IPFS or HTTP URI
                            const resolvedURI = tokenURI.startsWith('ipfs://')
                                ? tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/')
                                : tokenURI;

                            console.log(`Fetching metadata for listing ${i} from: ${resolvedURI}`);

                            // Fetch metadata
                            const metadataResponse = await fetch(resolvedURI);
                            if (metadataResponse.ok) {
                                const metadata = await metadataResponse.json();
                                sanitizedListing.metadata = metadata;
                                sanitizedListing.name = metadata.name || sanitizedListing.name;

                                // Resolve image URL
                                if (metadata.image) {
                                    sanitizedListing.imageUrl = metadata.image.startsWith('ipfs://')
                                        ? metadata.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
                                        : metadata.image;
                                }
                            }
                        } catch (metadataError) {
                            console.warn(`Failed to fetch metadata for listing ${i}:`, metadataError);
                        }

                        res.push(sanitizedListing);
                    }
                } catch (err) {
                    // Skip this listing ID if it doesn't exist
                    console.log(`Skipping listing ${i}:`, err.message);
                }
            }

            setListings(res);

            // Set the top 5 as hot listings (could use other criteria)
            setHotListings(res.slice(0, 5));
            setStatus('');
        } catch (error) {
            setStatus('Failed to fetch listings');
            console.error("Error in fetchListings:", error);
        }
    };

    const buyListing = async (id, pricePerUnit, paymentToken) => {
        if (!signer || !marketplace) return;
        try {
            setStatus('Buying...');
            const tx = await marketplace.buy(id, 1, {
                value: paymentToken === ethers.ZeroAddress ? pricePerUnit : undefined
            });
            await tx.wait();
            setStatus('Purchased successfully!');
            fetchListings();
        } catch (e) {
            console.error(e);
            setStatus('Buy failed: ' + (e.message || e));
        }
    };

    // Fix for "marketplace.createListing is not a function" error
    // Fixed createListing function to use the correct variables
    // Fix for createListing function that correctly uses the function from the ABI
    const createListing = async (nftContract, tokenId, quantity, price, paymentToken) => {
        try {
            if (!signer) {
                setStatus("Error: Wallet not connected. Please connect your wallet first");
                return;
            }

            setStatus("Creating listing...");

            if (!marketplace) {
                throw new Error("Marketplace contract not initialized");
            }

            console.log("Creating listing with parameters:", {
                nftContract,
                tokenId,
                quantity,
                price,
                paymentToken
            });

            // Make sure we're using the contract with the signer
            const marketplaceWithSigner = marketplace.connect(signer);

            // Add safety checks before using functions
            if (!marketplaceWithSigner || !marketplaceWithSigner.interface) {
                throw new Error("Failed to connect contract with signer");
            }

            console.log("Attempting to create listing...");

            // Direct call without logging functions
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
            if (error.message.includes("contract runner does not support")) {
                setStatus("Error: Wallet not properly connected. Please disconnect and reconnect your wallet.");
            } else if (error.message.includes("user rejected transaction")) {
                setStatus("Transaction was rejected in your wallet");
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
            createListing
        }}>
            {children}
        </MarketplaceContext.Provider>
    );
}

export function useMarketplace() {
    return useContext(MarketplaceContext);
}