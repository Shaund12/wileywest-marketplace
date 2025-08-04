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
                    if (listing && listing.active) {
                        res.push({ id: i, ...listing });
                    }
                } catch (err) {
                    // Skip this listing ID if it doesn't exist
                }
            }
            setListings(res);

            // Set the top 5 as hot listings (could use other criteria)
            setHotListings(res.slice(0, 5));
            setStatus('');
        } catch (error) {
            setStatus('Failed to fetch listings');
            console.error(error);
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

    const createListing = async (nftContract, tokenId, quantity, price, paymentToken) => {
        if (!signer || !marketplace) return;
        setStatus('Creating listing...');

        try {
            // Try to approve via ERC721
            try {
                const erc721 = new ethers.Contract(nftContract, [
                    'function approve(address to, uint256 tokenId) public',
                    'function ownerOf(uint256 tokenId) view returns (address)'
                ], signer);
                await erc721.approve(marketplaceAddress, tokenId);
            } catch (e) {
                try {
                    // Try to approve via ERC1155
                    const erc1155 = new ethers.Contract(nftContract, [
                        'function setApprovalForAll(address operator, bool approved) external'
                    ], signer);
                    await erc1155.setApprovalForAll(marketplaceAddress, true);
                } catch (e2) {
                    console.warn('Approval failed', e2);
                }
            }

            const tx = await marketplace.createListing(
                nftContract,
                tokenId,
                quantity || 1,
                price,
                paymentToken === '' ? ethers.ZeroAddress : paymentToken
            );

            await tx.wait();
            setStatus('Listing created successfully!');
            fetchListings();
            return true;
        } catch (e) {
            console.error(e);
            setStatus('Create listing failed: ' + (e.message || e));
            return false;
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