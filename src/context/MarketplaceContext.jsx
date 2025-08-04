import React, { createContext, useState, useContext, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useWallet } from './WalletContext';
import { formatErrorMessage, logError, safeAsync, retryAsync } from '../utils/errorUtils';

const MarketplaceContext = createContext();

export function MarketplaceProvider({ children, marketplaceAddress, abi }) {
    const { wallet, signer, provider } = useWallet();
    const [marketplace, setMarketplace] = useState(null);
    const [listings, setListings] = useState([]);
    const [hotListings, setHotListings] = useState([]);
    const [status, setStatus] = useState('');
    const [error, setError] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const isConnectedRef = useRef(false);

    // Initialize marketplace contract
    useEffect(() => {
        if (marketplaceAddress && provider) {
            try {
                const contract = new ethers.Contract(marketplaceAddress, abi, provider);
                setMarketplace(contract);
                setError(null);
            } catch (error) {
                const errorMsg = formatErrorMessage(error, 'Failed to initialize marketplace contract');
                setError(errorMsg);
                logError(error, 'Marketplace Initialization', { marketplaceAddress });
            }
        }
    }, [marketplaceAddress, abi, provider]);

    // Update contract with signer when wallet connects
    useEffect(() => {
        if (signer && marketplace && !isConnectedRef.current) {
            try {
                isConnectedRef.current = true;
                const connectedContract = marketplace.connect(signer);
                setMarketplace(connectedContract);
                setError(null);
            } catch (error) {
                const errorMsg = formatErrorMessage(error, 'Failed to connect contract with signer');
                setError(errorMsg);
                logError(error, 'Contract Signer Connection');
            }
        } else if (!signer) {
            isConnectedRef.current = false;
        }
    }, [signer, marketplace]);

    const fetchListings = async () => {
        if (!marketplace) {
            setError('Marketplace contract not initialized');
            return;
        }
        
        setIsLoading(true);
        setStatus('Fetching listings...');
        setError(null);
        
        try {
            const res = await safeAsync(async () => {
                const listings = [];
                
                // Try to fetch listings with retry logic
                for (let i = 1; i < 20; i++) {
                    try {
                        const listing = await retryAsync(
                            () => marketplace.listings(i),
                            2, // 2 retries
                            500, // 500ms delay
                            `Fetch listing ${i}`
                        );
                        
                        if (listing && listing.active) {
                            listings.push({ id: i, ...listing });
                        }
                    } catch (err) {
                        // Skip this listing ID if it doesn't exist
                        console.warn(`Listing ${i} not found or error:`, err.message);
                    }
                }
                
                return listings;
            }, [], 'Fetch marketplace listings');

            setListings(res);
            // Set the top 5 as hot listings (could use other criteria)
            setHotListings(res.slice(0, 5));
            setStatus('');
        } catch (error) {
            const errorMsg = formatErrorMessage(error, 'Failed to fetch marketplace listings');
            setStatus('');
            setError(errorMsg);
            logError(error, 'Fetch Listings');
        } finally {
            setIsLoading(false);
        }
    };

    const buyListing = async (id, pricePerUnit, paymentToken) => {
        if (!signer || !marketplace) {
            setError('Wallet not connected or marketplace not initialized');
            return false;
        }
        
        try {
            setStatus('Processing purchase...');
            setError(null);
            
            const tx = await retryAsync(
                () => marketplace.buy(id, 1, {
                    value: paymentToken === ethers.ZeroAddress ? pricePerUnit : undefined
                }),
                2, // 2 retries
                1000, // 1 second delay
                'Buy NFT transaction'
            );
            
            setStatus('Confirming transaction...');
            await tx.wait();
            
            setStatus('Purchase successful!');
            
            // Refresh listings after successful purchase
            setTimeout(() => {
                fetchListings();
                setStatus('');
            }, 2000);
            
            return true;
        } catch (error) {
            const errorMsg = formatErrorMessage(error, 'Failed to complete purchase');
            setStatus('');
            setError(errorMsg);
            logError(error, 'Buy Listing', { id, pricePerUnit, paymentToken });
            return false;
        }
    };

    const createListing = async (nftContract, tokenId, quantity, price, paymentToken) => {
        if (!signer || !marketplace) {
            setError('Wallet not connected or marketplace not initialized');
            return false;
        }
        
        setStatus('Creating listing...');
        setError(null);

        try {
            // Try to approve via ERC721 first
            try {
                const erc721 = new ethers.Contract(nftContract, [
                    'function approve(address to, uint256 tokenId) public',
                    'function ownerOf(uint256 tokenId) view returns (address)'
                ], signer);
                
                setStatus('Approving NFT...');
                const approveTx = await retryAsync(
                    () => erc721.approve(marketplaceAddress, tokenId),
                    2,
                    1000,
                    'ERC721 approve'
                );
                await approveTx.wait();
            } catch (e) {
                try {
                    // Try to approve via ERC1155
                    const erc1155 = new ethers.Contract(nftContract, [
                        'function setApprovalForAll(address operator, bool approved) external'
                    ], signer);
                    
                    setStatus('Approving NFT collection...');
                    const approveTx = await retryAsync(
                        () => erc1155.setApprovalForAll(marketplaceAddress, true),
                        2,
                        1000,
                        'ERC1155 approve'
                    );
                    await approveTx.wait();
                } catch (e2) {
                    console.warn('Approval failed, continuing with listing creation', e2);
                }
            }

            setStatus('Creating marketplace listing...');
            const tx = await retryAsync(
                () => marketplace.createListing(
                    nftContract,
                    tokenId,
                    quantity || 1,
                    price,
                    paymentToken === '' ? ethers.ZeroAddress : paymentToken
                ),
                2,
                1000,
                'Create listing transaction'
            );

            setStatus('Confirming listing...');
            await tx.wait();
            
            setStatus('Listing created successfully!');
            
            // Refresh listings after successful creation
            setTimeout(() => {
                fetchListings();
                setStatus('');
            }, 2000);
            
            return true;
        } catch (error) {
            const errorMsg = formatErrorMessage(error, 'Failed to create listing');
            setStatus('');
            setError(errorMsg);
            logError(error, 'Create Listing', { nftContract, tokenId, quantity, price, paymentToken });
            return false;
        }
    };

    const clearError = () => {
        setError(null);
    };

    // Load listings on initial load
    useEffect(() => {
        if (marketplace) {
            fetchListings();
            // Use a ref to keep track of the interval
            const intervalId = setInterval(() => {
                safeAsync(
                    () => fetchListings(),
                    null,
                    'Periodic listings refresh'
                );
            }, 30000);
            
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
            error,
            isLoading,
            setStatus,
            clearError,
            fetchListings,
            buyListing,
            createListing
        }}>
            {children}
        </MarketplaceContext.Provider>
    );
}

export function useMarketplace() {
    const context = useContext(MarketplaceContext);
    if (!context) {
        throw new Error('useMarketplace must be used within a MarketplaceProvider');
    }
    return context;
}