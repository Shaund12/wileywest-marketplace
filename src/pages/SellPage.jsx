import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { useSearchParams } from 'react-router-dom';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';

// ERC721/ERC1155 metadata interfaces
const ERC721_ABI = [
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)'
];

const ERC1155_ABI = [
    'function uri(uint256 id) view returns (string)',
    'function balanceOf(address account, uint256 id) view returns (uint256)'
];

const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)'
];

// Token addresses with proper EIP-55 checksums
const WVTRU_ADDRESS = '0x3ccc3F22462cAe34766820894D04a40381201ef9';
const USDC_ADDRESS = '0xbCfB3FCa16b12C7756CD6C24f1cC0AC0E38569CF';

// Default token prices for testing
const DEFAULT_TOKEN_PRICES = {
    'VTRU': 25.0,
    'WVTRU': 25.0,
    'USDC': 1.0
};

function SellPage() {
    const { createListing, status, setStatus } = useMarketplace();
    const { wallet, connect, provider, signer } = useWallet();
    const [searchParams] = useSearchParams();

    // Form state
    const [formData, setFormData] = useState({
        nftContract: searchParams.get('contract') || '',
        tokenId: searchParams.get('tokenId') || '',
        quantity: '1',
        price: '',
        paymentToken: ethers.ZeroAddress
    });

    // NFT metadata state
    const [metadata, setMetadata] = useState(null);
    const [nftImage, setNftImage] = useState('');
    const [nftName, setNftName] = useState('');
    const [nftType, setNftType] = useState(null);
    const [balance, setBalance] = useState('0');
    const [loading, setLoading] = useState(false);
    const [ownershipVerified, setOwnershipVerified] = useState(false);

    // Price display state
    const [displayPrice, setDisplayPrice] = useState({
        wei: '',
        eth: '',
        usd: ''
    });

    // Token states
    const [tokenList, setTokenList] = useState({});
    const [paymentOptions, setPaymentOptions] = useState([]);
    const [loadingPrices, setLoadingPrices] = useState(false);
    const [showAddTokenForm, setShowAddTokenForm] = useState(false);
    const [customTokenData, setCustomTokenData] = useState({
        address: '',
        symbol: '',
        name: '',
        decimals: '18',
        price: ''
    });
    const [customTokenError, setCustomTokenError] = useState('');

    // Price ticker state
    const [livePrice, setLivePrice] = useState({});
    const [priceChange, setPriceChange] = useState({});
    const [lastUpdateTime, setLastUpdateTime] = useState(null);
    const [tickerRunning, setTickerRunning] = useState(false);

    // New state for preview tabs and fee calculations
    const [activePreviewTab, setActivePreviewTab] = useState('details');
    const [fees, setFees] = useState({
        marketplaceFee: 2.5, // 2.5% marketplace fee
        creatorRoyalty: 5.0, // 5.0% creator royalty
        networkFee: 0.001 // Estimated network fee in VTRU
    });

    // Price source tracking
    const [priceSource, setPriceSource] = useState({});

    // Format time for price ticker
    const formatTime = (date) => {
        if (!date) return '';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };

    // Handle form field changes
    const handleChange = (e) => {
        const { id, value } = e.target;

        if (id === 'price') {
            updatePriceDisplay(value, formData.paymentToken);
        }

        setFormData({
            ...formData,
            [id]: value
        });
    };

    // Update price display based on selected token
    const updatePriceDisplay = (weiValue, tokenAddress) => {
        try {
            if (!weiValue) {
                setDisplayPrice({ wei: '0', eth: '0', usd: '0.00' });
                return;
            }

            const token = tokenList[tokenAddress];
            if (!token) {
                setDisplayPrice({
                    wei: weiValue,
                    eth: ethers.formatUnits(weiValue, 18),
                    usd: 'Unknown'
                });
                return;
            }

            const tokenValue = ethers.formatUnits(weiValue, token.decimals || 18);

            // Calculate USD value if we have price
            let usdValue = 'Unknown';
            if (token.price) {
                usdValue = (parseFloat(tokenValue) * token.price).toFixed(2);
            }

            setDisplayPrice({
                wei: weiValue,
                eth: tokenValue,
                usd: usdValue
            });
        } catch (e) {
            console.error("Error updating price display", e);
        }
    };

    // Handle payment token selection
    const handlePaymentTokenChange = (e) => {
        const tokenAddress = e.target.value;
        setFormData({
            ...formData,
            paymentToken: tokenAddress
        });

        // Update price display with new token
        updatePriceDisplay(formData.price, tokenAddress);
    };

    // Initialize tokens
    useEffect(() => {
        if (provider) {
            initializeTokens();
        }
    }, [provider]);

    // Live price ticker
    useEffect(() => {
        let intervalId;

        if (tickerRunning && Object.keys(tokenList).length > 0) {
            // Initial update
            updateLivePrices();

            // Set up interval for updates
            intervalId = setInterval(() => {
                updateLivePrices();
            }, 15000); // Update every 15 seconds
        }

        return () => {
            if (intervalId) clearInterval(intervalId);
        };
    }, [tickerRunning, tokenList]);

    // Start ticker when tokens are loaded
    useEffect(() => {
        if (Object.keys(tokenList).length > 0 && !tickerRunning) {
            setTickerRunning(true);
        }
    }, [tokenList]);

    // Update live prices - simulates price fluctuations for demonstration
    const updateLivePrices = () => {
        try {
            const now = new Date();
            const previousPrices = { ...livePrice };
            const newPrices = {};
            const changes = {};

            // For each token with a price
            for (const [address, token] of Object.entries(tokenList)) {
                if (token.price) {
                    // Add small random fluctuation (-2% to +2%)
                    const fluctuation = (Math.random() * 4 - 2) / 100;
                    const newPrice = token.price * (1 + fluctuation);

                    newPrices[address] = newPrice;

                    // Calculate price change
                    if (previousPrices[address]) {
                        const changePercent = ((newPrice - previousPrices[address]) / previousPrices[address]) * 100;
                        changes[address] = changePercent;
                    } else {
                        changes[address] = 0;
                    }

                    // Update token price in tokenList
                    setTokenList(prev => ({
                        ...prev,
                        [address]: {
                            ...prev[address],
                            price: newPrice
                        }
                    }));
                }
            }

            setLivePrice(newPrices);
            setPriceChange(changes);
            setLastUpdateTime(now);

            // Update price display if needed
            if (formData.price && formData.paymentToken) {
                updatePriceDisplay(formData.price, formData.paymentToken);
            }
        } catch (error) {
            console.error("Error updating live prices", error);
        }
    };

    // Initialize tokens with static data
    const initializeTokens = async () => {
        setLoadingPrices(true);

        const initialTokens = {};

        try {
            // Initialize Native VTRU
            initialTokens[ethers.ZeroAddress] = {
                address: ethers.ZeroAddress,
                symbol: 'VTRU',
                name: 'Native VTRU',
                decimals: 18,
                isNative: true,
                price: DEFAULT_TOKEN_PRICES.VTRU
            };

            // Add WVTRU token
            try {
                const wvtruContract = new ethers.Contract(WVTRU_ADDRESS, ERC20_ABI, provider);
                let wvtruSymbol, wvtruName, wvtruDecimals;

                try {
                    wvtruSymbol = await wvtruContract.symbol();
                    wvtruName = await wvtruContract.name();
                    wvtruDecimals = await wvtruContract.decimals();
                } catch (e) {
                    console.warn("Could not fetch WVTRU details, using defaults", e);
                    wvtruSymbol = 'WVTRU';
                    wvtruName = 'Wrapped VTRU';
                    wvtruDecimals = 18;
                }

                initialTokens[WVTRU_ADDRESS] = {
                    address: WVTRU_ADDRESS,
                    symbol: wvtruSymbol,
                    name: wvtruName,
                    decimals: wvtruDecimals,
                    price: DEFAULT_TOKEN_PRICES.WVTRU
                };
            } catch (error) {
                console.warn("Could not load WVTRU token, using defaults", error);
                initialTokens[WVTRU_ADDRESS] = {
                    address: WVTRU_ADDRESS,
                    symbol: 'WVTRU',
                    name: 'Wrapped VTRU',
                    decimals: 18,
                    price: DEFAULT_TOKEN_PRICES.WVTRU
                };
            }

            // Add USDC token
            try {
                const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
                let usdcSymbol, usdcName, usdcDecimals;

                try {
                    usdcSymbol = await usdcContract.symbol();
                    usdcName = await usdcContract.name();
                    usdcDecimals = await usdcContract.decimals();
                } catch (e) {
                    console.warn("Could not fetch USDC details, using defaults", e);
                    usdcSymbol = 'USDC';
                    usdcName = 'USD Coin';
                    usdcDecimals = 6;
                }

                initialTokens[USDC_ADDRESS] = {
                    address: USDC_ADDRESS,
                    symbol: usdcSymbol,
                    name: usdcName,
                    decimals: usdcDecimals,
                    price: DEFAULT_TOKEN_PRICES.USDC
                };
            } catch (error) {
                console.warn("Could not load USDC token, using defaults", error);
                initialTokens[USDC_ADDRESS] = {
                    address: USDC_ADDRESS,
                    symbol: 'USDC',
                    name: 'USD Coin',
                    decimals: 6,
                    price: DEFAULT_TOKEN_PRICES.USDC
                };
            }

            // Set token list with initial data
            setTokenList(initialTokens);

            // Set price sources
            setPriceSource({
                [ethers.ZeroAddress]: 'Default market price',
                [WVTRU_ADDRESS]: 'Default market price',
                [USDC_ADDRESS]: 'USD pegged stablecoin'
            });

            // Initialize live prices
            setLivePrice({
                [ethers.ZeroAddress]: DEFAULT_TOKEN_PRICES.VTRU,
                [WVTRU_ADDRESS]: DEFAULT_TOKEN_PRICES.WVTRU,
                [USDC_ADDRESS]: DEFAULT_TOKEN_PRICES.USDC
            });

            setLastUpdateTime(new Date());

        } catch (error) {
            console.error("Error initializing tokens", error);
        } finally {
            setLoadingPrices(false);
            buildPaymentOptions();
        }
    };

    // Build payment options from token list
    const buildPaymentOptions = () => {
        const options = Object.entries(tokenList).map(([address, token]) => ({
            address,
            name: `${token.symbol}${token.isNative ? ' (Native)' : ''}`,
            fullName: token.name,
            symbol: token.symbol,
            price: token.price || null,
            priceSource: priceSource[address] || 'Unknown'
        }));

        setPaymentOptions(options);
    };

    // Update payment options when token list changes
    useEffect(() => {
        if (Object.keys(tokenList).length > 0) {
            buildPaymentOptions();
        }
    }, [tokenList, priceSource]);

    // Handle custom token changes
    const handleCustomTokenChange = (e) => {
        const { id, value } = e.target;
        setCustomTokenData({
            ...customTokenData,
            [id]: value
        });
    };

    // Add custom token
    const addCustomToken = async () => {
        setCustomTokenError('');

        if (!ethers.isAddress(customTokenData.address)) {
            setCustomTokenError('Invalid address format');
            return;
        }

        try {
            const checksumAddress = ethers.getAddress(customTokenData.address);

            // Check if token already exists
            if (tokenList[checksumAddress]) {
                setCustomTokenError('Token already added');
                return;
            }

            setLoadingPrices(true);

            // Try to get token data from chain
            const contract = new ethers.Contract(checksumAddress, ERC20_ABI, provider);
            let symbol, name, decimals;

            try {
                symbol = await contract.symbol();
                name = await contract.name();
                decimals = await contract.decimals();
            } catch (e) {
                console.warn("Could not fetch token data from chain, using provided data", e);
                symbol = customTokenData.symbol || 'UNKNOWN';
                name = customTokenData.name || 'Custom Token';
                decimals = parseInt(customTokenData.decimals) || 18;
            }

            const price = customTokenData.price ? parseFloat(customTokenData.price) : null;

            // Add token to list
            const newToken = {
                address: checksumAddress,
                symbol,
                name,
                decimals,
                price
            };

            setTokenList(prev => ({
                ...prev,
                [checksumAddress]: newToken
            }));

            // Record price source
            if (price) {
                setPriceSource(prev => ({
                    ...prev,
                    [checksumAddress]: 'Manually entered'
                }));

                // Add to live price
                setLivePrice(prev => ({
                    ...prev,
                    [checksumAddress]: price
                }));
            }

            // Reset form
            setCustomTokenData({
                address: '',
                symbol: '',
                name: '',
                decimals: '18',
                price: ''
            });

            setShowAddTokenForm(false);
        } catch (error) {
            setCustomTokenError(`Error adding token: ${error.message}`);
            console.error("Error adding custom token", error);
        } finally {
            setLoadingPrices(false);
        }
    };

    // Fetch NFT metadata when contract address and token ID are provided
    useEffect(() => {
        if (formData.nftContract && formData.tokenId && wallet) {
            fetchNftMetadata();
        }
    }, [formData.nftContract, formData.tokenId, wallet]);

    // Handle NFT metadata fetching
    const fetchNftMetadata = async () => {
        if (!formData.nftContract || !formData.tokenId || !provider || !wallet) return;

        setLoading(true);
        setStatus('Fetching NFT metadata...');
        setMetadata(null);
        setNftImage('');
        setNftName('');
        setOwnershipVerified(false);

        try {
            // First try as ERC721
            const erc721Contract = new ethers.Contract(formData.nftContract, ERC721_ABI, provider);

            try {
                // Check ownership
                const owner = await erc721Contract.ownerOf(formData.tokenId);
                const isOwner = owner.toLowerCase() === wallet.toLowerCase();
                setOwnershipVerified(isOwner);

                if (!isOwner) {
                    setStatus('Warning: You are not the owner of this NFT');
                    setLoading(false);
                    return;
                }

                // Get token URI
                const tokenURI = await erc721Contract.tokenURI(formData.tokenId);
                const resolvedUri = resolveIpfsUri(tokenURI);

                // Fetch metadata
                const metadataResponse = await fetch(resolvedUri);
                const metadataJson = await metadataResponse.json();
                setMetadata(metadataJson);

                // Set NFT details
                setNftName(metadataJson.name || `NFT #${formData.tokenId}`);
                setNftImage(resolveIpfsUri(metadataJson.image) || '');
                setNftType('ERC721');
                setBalance('1');
                setStatus('');

            } catch (e) {
                console.log("Not an ERC721 or error", e);

                // Try as ERC1155
                try {
                    const erc1155Contract = new ethers.Contract(formData.nftContract, ERC1155_ABI, provider);

                    // Check ownership
                    const bal = await erc1155Contract.balanceOf(wallet, formData.tokenId);
                    const ownerBalance = bal.toString();
                    setBalance(ownerBalance);

                    if (ownerBalance === '0') {
                        setStatus('Warning: You do not own any of these tokens');
                        setLoading(false);
                        return;
                    }

                    setOwnershipVerified(true);

                    // Get token URI
                    const tokenURI = await erc1155Contract.uri(formData.tokenId);
                    const resolvedUri = resolveIpfsUri(tokenURI).replace('{id}', formData.tokenId);

                    // Fetch metadata
                    const metadataResponse = await fetch(resolvedUri);
                    const metadataJson = await metadataResponse.json();
                    setMetadata(metadataJson);

                    // Set NFT details
                    setNftName(metadataJson.name || `NFT #${formData.tokenId}`);
                    setNftImage(resolveIpfsUri(metadataJson.image) || '');
                    setNftType('ERC1155');

                    // Update quantity
                    setFormData(prev => ({
                        ...prev,
                        quantity: ownerBalance
                    }));

                    setStatus('');

                } catch (e2) {
                    console.log("Not an ERC1155 either", e2);
                    setStatus('Could not fetch NFT metadata. Make sure the contract and token ID are correct.');
                }
            }
        } catch (error) {
            console.error("Error fetching NFT metadata:", error);
            setStatus('Error fetching NFT metadata: ' + (error.message || error));
        } finally {
            setLoading(false);
        }
    };

    // Helper to resolve IPFS URIs
    const resolveIpfsUri = (uri) => {
        if (!uri) return '';

        if (uri.startsWith('ipfs://')) {
            return uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
        }

        return uri;
    };

    // Handle form submission
    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!wallet) {
            await connect();
            return;
        }

        if (!ownershipVerified) {
            setStatus('Error: Ownership not verified. You must own this NFT to list it.');
            return;
        }

        await createListing(
            formData.nftContract,
            formData.tokenId,
            formData.quantity,
            formData.price,
            formData.paymentToken
        );
    };

    // Calculate seller proceeds
    const calculateProceeds = () => {
        if (!displayPrice.eth || !formData.quantity) return {
            subtotal: '0',
            marketplaceFee: '0',
            royaltyFee: '0',
            total: '0',
            usdValue: '0'
        };

        const quantity = parseFloat(formData.quantity);
        const pricePerUnit = parseFloat(displayPrice.eth);
        const subtotal = quantity * pricePerUnit;

        const marketplaceFeeAmount = subtotal * (fees.marketplaceFee / 100);
        const royaltyFeeAmount = subtotal * (fees.creatorRoyalty / 100);
        const total = subtotal - marketplaceFeeAmount - royaltyFeeAmount;

        // Calculate USD values
        let usdValue = 'Unknown';
        const token = tokenList[formData.paymentToken];
        if (token?.price) {
            usdValue = (total * token.price).toFixed(2);
        }

        return {
            subtotal: subtotal.toFixed(6),
            marketplaceFee: marketplaceFeeAmount.toFixed(6),
            royaltyFee: royaltyFeeAmount.toFixed(6),
            total: total.toFixed(6),
            usdValue
        };
    };

    // Calculate proceeds whenever price or quantity changes
    const proceeds = calculateProceeds();

    // Function to render trait rarity indicator
    const getTraitRarity = (trait) => {
        // Simulate rarity data - in a real app, you'd get this from your backend
        const rarityMap = {
            'common': { label: 'Common', color: '#78909c', percentage: '25.4%' },
            'uncommon': { label: 'Uncommon', color: '#26a69a', percentage: '15.2%' },
            'rare': { label: 'Rare', color: '#5c6bc0', percentage: '8.7%' },
            'epic': { label: 'Epic', color: '#ab47bc', percentage: '3.2%' },
            'legendary': { label: 'Legendary', color: '#ffb300', percentage: '0.9%' }
        };

        // Get random rarity for demo purposes
        const rarities = Object.keys(rarityMap);
        const randomIndex = Math.floor((trait.trait_type.length + trait.value.length) % 5);
        const rarityKey = rarities[randomIndex];

        return rarityMap[rarityKey];
    };

    return (
        <div className="sell-container">
            <div className="page-header">
                <h1>Sell Your NFT</h1>
                <p>Create a listing for your digital asset</p>
            </div>

            {/* Price Ticker */}
            {Object.keys(livePrice).length > 0 && (
                <div className="price-ticker">
                    <div className="ticker-header">
                        <span>Live Token Prices</span>
                        <span className="ticker-time">
                            Last updated: {formatTime(lastUpdateTime)}
                        </span>
                    </div>
                    <div className="ticker-items">
                        {Object.entries(livePrice).map(([address, price]) => {
                            const token = tokenList[address];
                            const change = priceChange[address] || 0;
                            if (!token || token.isNative) return null; // Skip native token (shown with WVTRU)

                            return (
                                <div className="ticker-item" key={address}>
                                    <div className="ticker-symbol">{token.symbol}</div>
                                    <div className="ticker-price">${price.toFixed(4)}</div>
                                    <div className={`ticker-change ${change > 0 ? 'positive' : change < 0 ? 'negative' : ''}`}>
                                        {change > 0 ? '+' : ''}{change.toFixed(2)}%
                                    </div>
                                </div>
                            );
                        })}
                        <div className="ticker-refresh" onClick={updateLivePrices} title="Refresh Prices">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                            </svg>
                        </div>
                    </div>
                </div>
            )}

            <div className="sell-layout">
                <div className="sell-form">
                    <div className="card">
                        <form onSubmit={handleSubmit}>
                            <div className="form-section">
                                <h3>NFT Details</h3>
                                <div className="form-group">
                                    <label htmlFor="nftContract">NFT Contract Address</label>
                                    <input
                                        type="text"
                                        id="nftContract"
                                        className="input"
                                        value={formData.nftContract}
                                        onChange={handleChange}
                                        placeholder="0x..."
                                        required
                                    />
                                </div>

                                <div className="form-group">
                                    <label htmlFor="tokenId">Token ID</label>
                                    <input
                                        type="text"
                                        id="tokenId"
                                        className="input"
                                        value={formData.tokenId}
                                        onChange={handleChange}
                                        placeholder="1"
                                        required
                                    />
                                </div>

                                {!metadata && !loading && (
                                    <button
                                        type="button"
                                        className="secondary-button fetch-button"
                                        onClick={fetchNftMetadata}
                                    >
                                        Fetch NFT Data
                                    </button>
                                )}
                            </div>

                            {nftType && (
                                <div className="form-section">
                                    <h3>Listing Details</h3>

                                    <div className="form-group">
                                        <label htmlFor="quantity">Quantity to Sell</label>
                                        <div className="input-with-info">
                                            <input
                                                type="number"
                                                id="quantity"
                                                className="input"
                                                value={formData.quantity}
                                                onChange={handleChange}
                                                placeholder="1"
                                                min="1"
                                                max={balance}
                                                required
                                            />
                                            <div className="input-info">
                                                Available: {balance}
                                            </div>
                                        </div>
                                        {nftType === 'ERC721' && (
                                            <div className="small">ERC-721 NFTs are unique and quantity will be 1</div>
                                        )}
                                    </div>

                                    <div className="form-group">
                                        <label htmlFor="price">Price per Unit</label>
                                        <div className="price-input-container">
                                            <input
                                                type="text"
                                                id="price"
                                                className="input price-input"
                                                value={formData.price}
                                                onChange={handleChange}
                                                placeholder="1000000000000000000"
                                                required
                                            />
                                            <div className="price-conversion">
                                                <div className="price-eth">
                                                    {displayPrice.eth} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                </div>
                                                <div className="price-usd">
                                                    ≈ {displayPrice.usd === 'Unknown' ? 'Unknown USD value' : `$${displayPrice.usd} USD`}
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="form-group">
                                        <div className="payment-header">
                                            <label>Payment Token</label>
                                            <button
                                                type="button"
                                                className="add-token-button"
                                                onClick={() => setShowAddTokenForm(!showAddTokenForm)}
                                            >
                                                {showAddTokenForm ? 'Cancel' : '+ Add Custom Token'}
                                            </button>
                                        </div>

                                        {showAddTokenForm && (
                                            <div className="custom-token-form">
                                                <h4>Add Custom Token</h4>

                                                <div className="form-group">
                                                    <label htmlFor="address">Token Address *</label>
                                                    <input
                                                        type="text"
                                                        id="address"
                                                        className="input"
                                                        value={customTokenData.address}
                                                        onChange={handleCustomTokenChange}
                                                        placeholder="0x..."
                                                        required
                                                    />
                                                </div>

                                                <div className="form-row">
                                                    <div className="form-group">
                                                        <label htmlFor="symbol">Symbol</label>
                                                        <input
                                                            type="text"
                                                            id="symbol"
                                                            className="input"
                                                            value={customTokenData.symbol}
                                                            onChange={handleCustomTokenChange}
                                                            placeholder="Will auto-detect if available"
                                                        />
                                                    </div>

                                                    <div className="form-group">
                                                        <label htmlFor="decimals">Decimals</label>
                                                        <input
                                                            type="number"
                                                            id="decimals"
                                                            className="input"
                                                            value={customTokenData.decimals}
                                                            onChange={handleCustomTokenChange}
                                                            placeholder="18"
                                                        />
                                                    </div>
                                                </div>

                                                <div className="form-group">
                                                    <label htmlFor="name">Token Name</label>
                                                    <input
                                                        type="text"
                                                        id="name"
                                                        className="input"
                                                        value={customTokenData.name}
                                                        onChange={handleCustomTokenChange}
                                                        placeholder="Will auto-detect if available"
                                                    />
                                                </div>

                                                <div className="form-group">
                                                    <label htmlFor="price">USD Price (optional)</label>
                                                    <div className="input-with-info">
                                                        <input
                                                            type="number"
                                                            id="price"
                                                            className="input"
                                                            value={customTokenData.price}
                                                            onChange={handleCustomTokenChange}
                                                            placeholder="Token USD price"
                                                            step="0.000001"
                                                        />
                                                        <div className="input-info">
                                                            Enter USD price manually
                                                        </div>
                                                    </div>
                                                </div>

                                                {customTokenError && (
                                                    <div className="error-message">{customTokenError}</div>
                                                )}

                                                <div className="form-actions token-actions">
                                                    <button
                                                        type="button"
                                                        className="secondary-button"
                                                        onClick={() => setShowAddTokenForm(false)}
                                                    >
                                                        Cancel
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="primary-button"
                                                        onClick={addCustomToken}
                                                        disabled={!customTokenData.address || loadingPrices}
                                                    >
                                                        {loadingPrices ? 'Adding...' : 'Add Token'}
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {loadingPrices && !showAddTokenForm ? (
                                            <div className="loading-tokens">
                                                <div className="loader"></div>
                                                <p>Loading token information...</p>
                                            </div>
                                        ) : (
                                            <div className="token-selector">
                                                {paymentOptions.map(option => (
                                                    <div
                                                        className={`token-option ${formData.paymentToken === option.address ? 'selected' : ''}`}
                                                        key={option.address}
                                                    >
                                                        <input
                                                            type="radio"
                                                            id={`token-${option.address}`}
                                                            name="paymentToken"
                                                            value={option.address}
                                                            checked={formData.paymentToken === option.address}
                                                            onChange={handlePaymentTokenChange}
                                                        />
                                                        <label htmlFor={`token-${option.address}`} className="token-label">
                                                            <div className="token-info">
                                                                <div className="token-name">{option.name}</div>
                                                                <div className="token-full-name">{option.fullName}</div>
                                                            </div>
                                                            <div className="token-price-info">
                                                                {option.price !== null ? (
                                                                    <div className="token-price">${option.price.toFixed(2)} USD</div>
                                                                ) : (
                                                                    <div className="token-price-unknown">Price unknown</div>
                                                                )}
                                                                <div className="price-source">{option.priceSource}</div>
                                                            </div>
                                                        </label>
                                                    </div>
                                                ))}

                                                {paymentOptions.length === 0 && (
                                                    <div className="no-tokens-message">
                                                        No tokens available. Add a custom token to continue.
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            <div className="form-actions">
                                {!wallet ? (
                                    <button type="button" className="secondary-button" onClick={connect}>
                                        Connect Wallet First
                                    </button>
                                ) : !ownershipVerified && metadata ? (
                                    <button type="button" className="warning-button" disabled>
                                        You don't own this NFT
                                    </button>
                                ) : (
                                    <button
                                        type="submit"
                                        className="primary-button"
                                        disabled={!wallet || !metadata || status.includes('Creating') || !ownershipVerified}
                                    >
                                        {status.includes('Creating') ? 'Processing...' : 'List NFT for Sale'}
                                    </button>
                                )}
                            </div>

                            {status && <div className={`status-message ${status.includes('Warning') ? 'warning' : ''}`}>{status}</div>}
                        </form>
                    </div>
                </div>

                <div className="nft-preview">
                    {loading ? (
                        <div className="preview-loading">
                            <div className="loader"></div>
                            <p>Loading NFT data...</p>
                        </div>
                    ) : metadata ? (
                        <div className="premium-preview">
                            <div className="preview-header">
                                <div className="preview-badge">
                                    {nftType || 'NFT'}
                                </div>
                                {ownershipVerified && (
                                    <div className="ownership-badge">
                                        <svg viewBox="0 0 24 24" width="16" height="16" fill="#22cc88">
                                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                                        </svg>
                                        <span>Verified Owner</span>
                                    </div>
                                )}
                            </div>

                            <div className="premium-image-container">
                                {nftImage ? (
                                    <div className="premium-image-wrapper">
                                        <img
                                            src={nftImage}
                                            alt={nftName}
                                            className="premium-image"
                                        />
                                        <div className="image-overlay">
                                            <a
                                                href={nftImage}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="zoom-button"
                                                title="View Full Size"
                                            >
                                                <svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
                                                    <path d="M15 3l2.3 2.3-2.89 2.87 1.42 1.42L18.7 6.7 21 9V3h-6zM3 9l2.3-2.3 2.87 2.89 1.42-1.42L6.7 5.3 9 3H3v6zm6 12l-2.3-2.3 2.89-2.87-1.42-1.42L5.3 17.3 3 15v6h6zm12-6l-2.3 2.3-2.87-2.89-1.42 1.42 2.89 2.87L15 21h6v-6z" />
                                                </svg>
                                            </a>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="no-image">No image available</div>
                                )}
                            </div>

                            <div className="preview-title-section">
                                <h2 className="preview-name">{nftName}</h2>
                                <div className="preview-contract">
                                    <span className="contract-label">Contract:</span>
                                    <span className="contract-address">{`${formData.nftContract.slice(0, 6)}...${formData.nftContract.slice(-4)}`}</span>
                                    <span className="token-id">#{formData.tokenId}</span>
                                </div>
                            </div>

                            <div className="preview-tabs">
                                <button
                                    className={activePreviewTab === 'details' ? 'active' : ''}
                                    onClick={() => setActivePreviewTab('details')}
                                >
                                    Details
                                </button>
                                <button
                                    className={activePreviewTab === 'properties' ? 'active' : ''}
                                    onClick={() => setActivePreviewTab('properties')}
                                >
                                    Properties
                                </button>
                                <button
                                    className={activePreviewTab === 'pricing' ? 'active' : ''}
                                    onClick={() => setActivePreviewTab('pricing')}
                                >
                                    Pricing & Fees
                                </button>
                            </div>

                            <div className="preview-tab-content">
                                {activePreviewTab === 'details' && (
                                    <div className="details-tab">
                                        <div className="detail-section">
                                            <h4>Description</h4>
                                            <p className="description-text">
                                                {metadata.description || 'No description available for this NFT.'}
                                            </p>
                                        </div>

                                        <div className="detail-section">
                                            <h4>NFT Details</h4>
                                            <div className="detail-grid">
                                                <div className="detail-item">
                                                    <div className="detail-label">Token Standard</div>
                                                    <div className="detail-value">{nftType}</div>
                                                </div>
                                                <div className="detail-item">
                                                    <div className="detail-label">Token ID</div>
                                                    <div className="detail-value">{formData.tokenId}</div>
                                                </div>
                                                <div className="detail-item">
                                                    <div className="detail-label">Chain</div>
                                                    <div className="detail-value">Vitruveo</div>
                                                </div>
                                                <div className="detail-item">
                                                    <div className="detail-label">Owner</div>
                                                    <div className="detail-value highlight">You</div>
                                                </div>
                                                {nftType === 'ERC1155' && (
                                                    <div className="detail-item">
                                                        <div className="detail-label">Quantity Owned</div>
                                                        <div className="detail-value">{balance}</div>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {activePreviewTab === 'properties' && (
                                    <div className="properties-tab">
                                        {metadata.attributes && metadata.attributes.length > 0 ? (
                                            <div className="traits-container">
                                                {metadata.attributes.map((attr, index) => {
                                                    const rarity = getTraitRarity(attr);
                                                    return (
                                                        <div className="trait-card" key={index}>
                                                            <div className="trait-type">{attr.trait_type}</div>
                                                            <div className="trait-value">{attr.value}</div>
                                                            <div className="trait-rarity" style={{ color: rarity.color }}>
                                                                <span className="rarity-badge" style={{ backgroundColor: rarity.color }}>{rarity.label}</span>
                                                                <span className="rarity-percent">{rarity.percentage}</span>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        ) : (
                                            <div className="no-properties">
                                                <p>No properties found for this NFT.</p>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {activePreviewTab === 'pricing' && (
                                    <div className="pricing-tab">
                                        <div className="pricing-summary">
                                            <div className="pricing-row">
                                                <div className="pricing-label">Listing Subtotal</div>
                                                <div className="pricing-value">
                                                    <span>{proceeds.subtotal} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}</span>
                                                    <span className="pricing-usd">
                                                        {proceeds.usdValue === 'Unknown' ?
                                                            '(USD value unknown)' :
                                                            `($${proceeds.usdValue})`}
                                                    </span>
                                                </div>
                                            </div>

                                            <div className="pricing-row fee">
                                                <div className="pricing-label">
                                                    <span>Marketplace Fee ({fees.marketplaceFee}%)</span>
                                                    <span className="info-icon" title="Fee charged by the marketplace">ⓘ</span>
                                                </div>
                                                <div className="pricing-value negative">
                                                    -{proceeds.marketplaceFee} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                </div>
                                            </div>

                                            <div className="pricing-row fee">
                                                <div className="pricing-label">
                                                    <span>Creator Royalty ({fees.creatorRoyalty}%)</span>
                                                    <span className="info-icon" title="Royalty paid to the original creator">ⓘ</span>
                                                </div>
                                                <div className="pricing-value negative">
                                                    -{proceeds.royaltyFee} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                </div>
                                            </div>

                                            <div className="pricing-divider"></div>

                                            <div className="pricing-row total">
                                                <div className="pricing-label">You'll Receive</div>
                                                <div className="pricing-value">
                                                    <span>{proceeds.total} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}</span>
                                                    <span className="pricing-usd">
                                                        {proceeds.usdValue === 'Unknown' ?
                                                            '(USD value unknown)' :
                                                            `($${proceeds.usdValue})`}
                                                    </span>
                                                </div>
                                            </div>

                                            <div className="network-fee-note">
                                                <svg viewBox="0 0 24 24" width="16" height="16">
                                                    <path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                                                </svg>
                                                <span>Estimated network fee: {fees.networkFee} VTRU</span>
                                            </div>

                                            {tokenList[formData.paymentToken]?.price ? (
                                                <div className="price-source-note">
                                                    <span>Price data source: {priceSource[formData.paymentToken] || 'Unknown'}</span>
                                                </div>
                                            ) : (
                                                <div className="price-source-note warning">
                                                    <svg viewBox="0 0 24 24" width="16" height="16">
                                                        <path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" />
                                                    </svg>
                                                    <span>No USD price data available for this token</span>
                                                </div>
                                            )}
                                        </div>

                                        <div className="pricing-explainer">
                                            <h4>How our fees work</h4>
                                            <p>Our marketplace charges {fees.marketplaceFee}% on all sales to support our platform development and operations. Creator royalties of {fees.creatorRoyalty}% ensure original creators are compensated for their work.</p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="empty-preview">
                            <div className="empty-preview-icon">🖼️</div>
                            <h3>NFT Preview</h3>
                            <p>Enter contract address and token ID to load NFT details</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default SellPage;