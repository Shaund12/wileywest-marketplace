import React, { useState, useEffect } from 'react';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { ethers } from 'ethers';
import ListingCard from '../components/ListingCard';

// Standard ERC721 and ERC1155 minimal ABIs
const ERC721_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)'
];

const ERC1155_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
    'function uri(uint256 id) view returns (string)'
];

function ProfilePage() {
    const { wallet, connect, provider, signer } = useWallet();
    const { listings, fetchListings } = useMarketplace();
    const [activeTab, setActiveTab] = useState('myListings');
    const [userListings, setUserListings] = useState([]);
    const [userNfts, setUserNfts] = useState([]);
    const [isLoading, setIsLoading] = useState(false);

    // Filter user's active listings
    useEffect(() => {
        if (wallet && listings.length > 0) {
            const filtered = listings.filter(
                listing => listing.seller.toLowerCase() === wallet.toLowerCase()
            );
            setUserListings(filtered);
        }
    }, [wallet, listings]);

    // Fetch all NFTs owned by the connected wallet
    const fetchUserNfts = async () => {
        if (!wallet || !provider) return;

        setIsLoading(true);
        setUserNfts([]);

        try {
            // Get a list of known NFT contracts from user's listings
            const nftContracts = [...new Set(listings
                .map(listing => listing.nftContract)
                .filter(address => !!address))];

            // Initialize array for NFT data
            const nftsFound = [];

            // Try to detect and fetch from popular NFT contracts first
            for (const contractAddress of nftContracts) {
                try {
                    // Try as ERC721
                    const erc721Contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
                    try {
                        const balance = await erc721Contract.balanceOf(wallet);

                        if (balance > 0) {
                            for (let i = 0; i < Math.min(balance, 50); i++) { // Limit to 50 NFTs per contract
                                try {
                                    const tokenId = await erc721Contract.tokenOfOwnerByIndex(wallet, i);
                                    let tokenURI = null;

                                    try {
                                        tokenURI = await erc721Contract.tokenURI(tokenId);
                                    } catch (e) {
                                        console.log("Error fetching tokenURI", e);
                                    }

                                    nftsFound.push({
                                        contractAddress,
                                        tokenId: tokenId.toString(),
                                        type: 'ERC721',
                                        tokenURI,
                                        balance: 1,
                                    });
                                } catch (e) {
                                    console.log("Error fetching token", e);
                                }
                            }
                        }
                    } catch (e) {
                        // Not an ERC721 or error - try as ERC1155
                        try {
                            // We'd need to know which token IDs to query for ERC1155
                            // This is just a placeholder for potential known token IDs
                            const erc1155Contract = new ethers.Contract(contractAddress, ERC1155_ABI, provider);

                            // For ERC1155, we need to know specific token IDs 
                            // Use token IDs from listings as a starting point
                            const listedTokenIds = listings
                                .filter(l => l.nftContract.toLowerCase() === contractAddress.toLowerCase())
                                .map(l => l.tokenId.toString());

                            for (const tokenId of listedTokenIds) {
                                try {
                                    const balance = await erc1155Contract.balanceOf(wallet, tokenId);

                                    if (balance > 0) {
                                        let uri = null;
                                        try {
                                            uri = await erc1155Contract.uri(tokenId);
                                        } catch (e) {
                                            console.log("Error fetching uri", e);
                                        }

                                        nftsFound.push({
                                            contractAddress,
                                            tokenId,
                                            type: 'ERC1155',
                                            tokenURI: uri,
                                            balance: balance.toString(),
                                        });
                                    }
                                } catch (e) {
                                    console.log("Error checking ERC1155 balance", e);
                                }
                            }
                        } catch (e) {
                            console.log("Not a standard ERC1155 either", e);
                        }
                    }
                } catch (e) {
                    console.log("Error checking contract", contractAddress, e);
                }
            }

            setUserNfts(nftsFound);
        } catch (error) {
            console.error("Error fetching NFTs:", error);
        } finally {
            setIsLoading(false);
        }
    };

    // Fetch NFTs when tab is changed to collection
    useEffect(() => {
        if (activeTab === 'collection' && wallet) {
            fetchUserNfts();
        }
    }, [activeTab, wallet]);

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
                        <span className="value">{wallet}</span>
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

            <div className="profile-content">
                {activeTab === 'myListings' && (
                    <div className="listings-grid">
                        {userListings.length > 0 ? (
                            userListings.map(listing => (
                                <ListingCard key={listing.id} listing={listing} showSeller={false} />
                            ))
                        ) : (
                            <div className="no-listings">
                                <p>You don't have any active listings</p>
                                <button className="secondary-button" onClick={() => window.location.href = '/sell'}>
                                    Create a Listing
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {activeTab === 'activity' && (
                    <div className="activity-container">
                        <p>Your recent transactions will appear here</p>
                    </div>
                )}

                {activeTab === 'collection' && (
                    <div className="collection-container">
                        {isLoading ? (
                            <div className="loading">Loading your NFT collection...</div>
                        ) : userNfts.length > 0 ? (
                            <div>
                                <div className="collection-stats">
                                    <p>Found {userNfts.length} NFTs in your wallet</p>
                                </div>
                                <div className="nft-grid">
                                    {userNfts.map((nft, index) => (
                                        <div key={`${nft.contractAddress}-${nft.tokenId}-${index}`} className="nft-card">
                                            <div className="nft-image">
                                                {/* Using placeholder image - in production, you would resolve the tokenURI */}
                                                <img src={`https://picsum.photos/seed/${nft.contractAddress}${nft.tokenId}/300/300`}
                                                    alt={`NFT ${nft.tokenId}`} />
                                            </div>
                                            <div className="nft-details">
                                                <h3>NFT #{nft.tokenId}</h3>
                                                <p className="nft-contract small">{nft.contractAddress.slice(0, 6)}...{nft.contractAddress.slice(-4)}</p>
                                                <div className="nft-type-badge">{nft.type}</div>
                                                {nft.type === 'ERC1155' && nft.balance > 1 && (
                                                    <div className="nft-quantity">Quantity: {nft.balance}</div>
                                                )}
                                                <button
                                                    className="secondary-button list-button"
                                                    onClick={() => {
                                                        window.location.href = `/sell?contract=${nft.contractAddress}&tokenId=${nft.tokenId}`;
                                                    }}
                                                >
                                                    List for Sale
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ) : (
                            <div className="no-nfts">
                                <p>No NFTs found in your wallet</p>
                                <p className="small">If you recently acquired NFTs, they may take a moment to appear</p>
                                <button className="secondary-button" onClick={fetchUserNfts}>
                                    Refresh NFTs
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

export default ProfilePage;