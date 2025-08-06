import { ethers } from 'ethers';

// Add ERC20 ABI for detection
const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'event Transfer(address indexed from, address indexed to, uint256 value)'
];

// Extended ABI elements to support more contract variations
const EXTENDED_ERC721_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

const EXTENDED_ERC1155_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function balanceOfBatch(address[] owners, uint256[] ids) view returns (uint256[])',
    'function uri(uint256 id) view returns (string)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
];

// Add well-known NFT contracts to force-scan
const KNOWN_NFT_CONTRACTS = [
    '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906', // Pixel Ninja Cats
];

// Known ERC20 tokens to exclude
const KNOWN_ERC20_CONTRACTS = [];

// Cache TTL in milliseconds (24 hours)
const CACHE_TTL = 24 * 60 * 60 * 1000;

/**
 * High-performance NFT scanner with caching and lazy loading
 */
export class NFTScanner {
    constructor(provider, walletAddress, statusCallback) {
        this.provider = provider;
        this.walletAddress = walletAddress;
        this.updateStatus = statusCallback || (() => {});
        this.progress = { found: 0, scanned: 0, total: 0 };
        this.nfts = [];
        this.contractCache = this.loadContractCache();
        this.errors = {}; // Track errors per contract
        this.knownErc20s = new Set([...KNOWN_ERC20_CONTRACTS.map(addr => addr.toLowerCase())]);
        this.loadKnownErc20s();
        this.metadataCache = this.loadMetadataCache();
        this.cachedNfts = null;
        
        // Background scanning state
        this.isBackgroundScanning = false;
        this.backgroundScanPromise = null;
    }

    // Load cached NFTs for this wallet
    loadCachedNfts() {
        try {
            const cacheKey = `nft_cache_${this.walletAddress.toLowerCase()}`;
            const cachedData = localStorage.getItem(cacheKey);
            
            if (cachedData) {
                const { nfts, timestamp } = JSON.parse(cachedData);
                
                // Check if cache is still valid (less than 24 hours old)
                if (timestamp && (Date.now() - timestamp < CACHE_TTL)) {
                    this.cachedNfts = nfts;
                    return nfts;
                }
            }
        } catch (e) {
            console.warn('Error loading cached NFTs:', e);
        }
        
        return null;
    }

    // Save NFTs to cache
    saveNftsToCache(nfts) {
        try {
            const cacheKey = `nft_cache_${this.walletAddress.toLowerCase()}`;
            const cacheData = {
                nfts,
                timestamp: Date.now(),
                chainId: this.provider._network?.chainId
            };
            
            localStorage.setItem(cacheKey, JSON.stringify(cacheData));
        } catch (e) {
            console.warn('Error saving NFTs to cache:', e);
        }
    }

    // Load contract cache
    loadContractCache() {
        try {
            const contractCacheData = localStorage.getItem('nft_contract_cache');
            if (contractCacheData) {
                return JSON.parse(contractCacheData);
            }
        } catch (e) {
            console.warn('Error loading contract cache:', e);
        }
        
        return {};
    }

    // Save contract cache
    saveContractCache() {
        try {
            localStorage.setItem('nft_contract_cache', JSON.stringify(this.contractCache));
        } catch (e) {
            console.warn('Error saving contract cache:', e);
        }
    }

    // Load known ERC20 tokens
    loadKnownErc20s() {
        try {
            const erc20Data = localStorage.getItem('known_erc20_tokens');
            if (erc20Data) {
                const tokens = JSON.parse(erc20Data);
                tokens.forEach(addr => this.knownErc20s.add(addr.toLowerCase()));
            }
        } catch (e) {
            console.warn('Error loading known ERC20 tokens:', e);
        }
    }

    // Save known ERC20 tokens
    saveKnownErc20s() {
        try {
            localStorage.setItem('known_erc20_tokens', 
                JSON.stringify([...this.knownErc20s]));
        } catch (e) {
            console.warn('Error saving known ERC20 tokens:', e);
        }
    }

    // Load metadata cache
    loadMetadataCache() {
        try {
            const metadataCache = localStorage.getItem('nft_metadata_cache');
            if (metadataCache) {
                return JSON.parse(metadataCache);
            }
        } catch (e) {
            console.warn('Error loading metadata cache:', e);
        }
        
        return {};
    }

    // Save metadata cache periodically
    saveMetadataCache() {
        try {
            // Only store important fields to keep cache size manageable
            const minimalCache = {};
            
            for (const key in this.metadataCache) {
                const item = this.metadataCache[key];
                minimalCache[key] = {
                    name: item.name,
                    description: item.description,
                    imageUrl: item.imageUrl,
                    attributes: item.attributes,
                    timestamp: Date.now()
                };
            }
            
            localStorage.setItem('nft_metadata_cache', JSON.stringify(minimalCache));
        } catch (e) {
            console.warn('Error saving metadata cache:', e);
        }
    }

    // Get cached metadata or null if not available
    getCachedMetadata(contractAddress, tokenId) {
        const key = `${contractAddress.toLowerCase()}-${tokenId}`;
        const cached = this.metadataCache[key];
        
        if (cached && cached.timestamp && (Date.now() - cached.timestamp < CACHE_TTL)) {
            return cached;
        }
        
        return null;
    }

    // Store metadata in cache
    cacheMetadata(contractAddress, tokenId, metadata) {
        const key = `${contractAddress.toLowerCase()}-${tokenId}`;
        this.metadataCache[key] = {
            ...metadata,
            timestamp: Date.now()
        };
        
        // Save cache every 10 items, using debouncing
        if (Object.keys(this.metadataCache).length % 10 === 0) {
            if (this.saveMetadataTimeout) {
                clearTimeout(this.saveMetadataTimeout);
            }
            this.saveMetadataTimeout = setTimeout(() => this.saveMetadataCache(), 2000);
        }
    }

    // Update progress and report
    updateProgress(updates) {
        this.progress = { ...this.progress, ...updates };
        this.updateStatus(`Scanning: Found ${this.progress.found} NFTs | Scanned ${this.progress.scanned}/${this.progress.total || '?'}`);
    }

    // Get all NFTs with caching support
    async getAllNFTs(forceRefresh = false) {
        // First try to use cached NFTs
        if (!forceRefresh) {
            const cachedNfts = this.loadCachedNfts();
            if (cachedNfts) {
                this.nfts = cachedNfts;
                this.updateStatus(`Loaded ${cachedNfts.length} NFTs from cache`);
                
                // Start background refresh if needed
                this.startBackgroundScan();
                
                return cachedNfts;
            }
        }
        
        // No valid cache, do a full scan
        const nfts = await this.scanAllNFTs();
        
        // Save to cache
        this.saveNftsToCache(nfts);
        
        return nfts;
    }
    
    // Start a background scan that doesn't block UI
    startBackgroundScan() {
        // Only start if we're not already scanning
        if (!this.isBackgroundScanning && !this.backgroundScanPromise) {
            this.isBackgroundScanning = true;
            
            // Use low priority to avoid blocking UI
            this.backgroundScanPromise = new Promise(resolve => {
                setTimeout(async () => {
                    try {
                        // Get fresh NFTs
                        const freshNfts = await this.scanAllNFTs(true);
                        
                        // Update cache with new results
                        this.saveNftsToCache(freshNfts);
                        
                        // Update current NFTs
                        this.nfts = freshNfts;
                        this.updateStatus(`Background scan complete - found ${freshNfts.length} NFTs`);
                    } catch (e) {
                        console.error('Background scan error:', e);
                    } finally {
                        this.isBackgroundScanning = false;
                        this.backgroundScanPromise = null;
                        resolve();
                    }
                }, 3000); // Wait 3 seconds before starting background scan
            });
        }
    }

    // Comprehensive scan for NFTs across ALL HISTORY
    async scanAllNFTs(isBackground = false) {
        try {
            // Reset progress
            this.progress = { found: 0, scanned: 0, total: 0 };
            
            // Start with known contracts
            let contractsToScan = [...KNOWN_NFT_CONTRACTS];
            
            // Add contracts from ALL historical transfers
            this.updateStatus("Finding NFT transfers to your wallet...");
            const transferContracts = await this.findContractsByTransfers();
            contractsToScan.push(...transferContracts);
            
            // Remove duplicates and invalid addresses
            contractsToScan = [...new Set(contractsToScan)]
                .filter(addr => ethers.isAddress(addr))
                .map(addr => ethers.getAddress(addr));
            
            // Filter out known ERC20 tokens
            contractsToScan = contractsToScan.filter(addr => 
                !this.knownErc20s.has(addr.toLowerCase())
            );
                
            // Update total for progress tracking
            this.updateProgress({ total: contractsToScan.length });
            this.updateStatus(`Found ${contractsToScan.length} potential NFT contracts to scan`);
            
            // Save contract cache and known ERC20s periodically
            const saveInterval = setInterval(() => {
                this.saveContractCache();
                this.saveKnownErc20s();
            }, 10000);
            
            // Gather all NFTs
            const allNfts = [];
            
            // Process in batches (smaller batch size for background scan)
            const batchSize = isBackground ? 1 : 3;
            
            try {
                for (let i = 0; i < contractsToScan.length; i += batchSize) {
                    const batch = contractsToScan.slice(i, i + batchSize);
                    
                    // Process contracts in parallel
                    const batchResults = await Promise.all(batch.map(address => 
                        this.scanSingleContract(address).catch(e => {
                            console.error(`Error in batch scan for ${address}:`, e);
                            return [];
                        })
                    ));
                    
                    // Add batch results to all NFTs
                    batchResults.forEach(nfts => allNfts.push(...nfts));
                    
                    // For background scan, yield to main thread periodically
                    if (isBackground && i % 10 === 0) {
                        await new Promise(r => setTimeout(r, 100));
                    }
                    
                    // Small delay between batches
                    if (i + batchSize < contractsToScan.length) {
                        await new Promise(r => setTimeout(r, isBackground ? 500 : 300));
                    }
                }
            } finally {
                clearInterval(saveInterval);
                this.saveContractCache();
                this.saveKnownErc20s();
            }
            
            this.updateStatus(`Complete! Found ${allNfts.length} NFTs`);
            return allNfts;
        } catch (error) {
            console.error("Error in comprehensive NFT scan:", error);
            this.updateStatus(`Error scanning: ${error.message}`);
            return this.nfts; // Return whatever we found so far
        }
    }
    
    // Scan a single contract with proper error handling
    async scanSingleContract(address) {
        try {
            // First check if this is an ERC20 token
            if (await this.isERC20Token(address)) {
                this.knownErc20s.add(address.toLowerCase());
                console.log(`Skipping ERC20 token: ${address}`);
                return [];
            }
            
            // Then try to detect if this is an NFT contract
            const contractType = await this.detectNFTStandard(address);
            
            if (contractType === 'ERC721') {
                this.updateStatus(`Scanning ERC721 contract: ${address}`);
                const erc721NFTs = await this.scanERC721Contract(address);
                return erc721NFTs;
            } 
            else if (contractType === 'ERC1155') {
                this.updateStatus(`Scanning ERC1155 contract: ${address}`);
                const erc1155NFTs = await this.scanERC1155Contract(address);
                return erc1155NFTs;
            }
            
            // Not an NFT contract we recognize
            return [];
        } catch (error) {
            // Only log first few errors to avoid console spam
            if (Object.keys(this.errors).length < 5) {
                console.error(`Error scanning contract ${address}:`, error);
                this.errors[address] = error.message;
            } else if (!this.errors[address]) {
                this.errors[address] = error.message;
            }
            
            // Update progress even on error
            this.updateProgress({ scanned: this.progress.scanned + 1 });
            return [];
        }
    }

    // Check if a contract is an ERC20 token
    async isERC20Token(contractAddress) {
        // Check cache first
        if (this.knownErc20s.has(contractAddress.toLowerCase())) {
            return true;
        }

        try {
            // Quick check for decimals() function which exists in ERC20 but not in NFTs
            const erc20Contract = new ethers.Contract(contractAddress, ERC20_ABI, this.provider);
            
            try {
                const decimals = await erc20Contract.decimals();
                // If we got decimals, this is likely an ERC20 token
                this.knownErc20s.add(contractAddress.toLowerCase());
                return true;
            } catch (e) {
                // No decimals function, could be NFT or something else
            }
            
            // Additional check to see if this might be a token with non-indexed tokenId in Transfer
            try {
                // Get recent transfers (ERC20 usually has regular transfers)
                const filter = {
                    address: contractAddress,
                    topics: [ethers.id("Transfer(address,address,uint256)")],
                    fromBlock: -10000,  // Recent blocks only for this check
                    toBlock: 'latest'
                };
                
                const logs = await this.provider.getLogs(filter);
                
                // Check a sample of logs to see if they have 3 topics (ERC20) or 4 topics (ERC721)
                const sampleSize = Math.min(logs.length, 10);
                
                if (sampleSize > 0) {
                    let erc20Count = 0;
                    let erc721Count = 0;
                    
                    for (let i = 0; i < sampleSize; i++) {
                        // ERC20 Transfer has exactly 3 topics, ERC721 has 4 (tokenId is indexed)
                        if (logs[i].topics.length === 3) {
                            erc20Count++;
                        } else if (logs[i].topics.length === 4) {
                            erc721Count++;
                        }
                    }
                    
                    // If majority of transfers look like ERC20, classify as ERC20
                    if (erc20Count > erc721Count) {
                        this.knownErc20s.add(contractAddress.toLowerCase());
                        return true;
                    }
                }
            } catch (e) {
                // Error checking transfers, continue with other methods
            }
            
            return false;
            
        } catch (error) {
            console.warn(`Error checking if ${contractAddress} is ERC20:`, error);
            return false;
        }
    }

    // Find contracts from Transfer events 
    async findContractsByTransfers() {
        try {
            const contracts = new Set();
            
            // Try with fromBlock=0 first, but fall back to a more recent block if needed
            await this.findTransfersByChunks(ethers.id("Transfer(address,address,uint256)"), 
                ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32), 
                contracts);
            
            // Try ERC1155 TransferSingle events with chunking too
            await this.findTransfersByChunks(ethers.id("TransferSingle(address,address,address,uint256,uint256)"),
                ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32),
                contracts,
                true); // This flag indicates it's an ERC1155 event
            
            // Filter out known ERC20s
            const filteredContracts = [...contracts].filter(addr => 
                !this.knownErc20s.has(addr.toLowerCase())
            );
                
            this.updateStatus(`Found ${filteredContracts.length} potential NFT contracts from your wallet's history`);
            return filteredContracts;
        } catch (error) {
            console.error("Error finding contracts by transfers:", error);
            return [];
        }
    }
    
    // Find transfers by breaking into smaller chunks
    async findTransfersByChunks(eventTopic, walletTopic, contracts, isErc1155 = false) {
        try {
            const currentBlock = await this.provider.getBlockNumber();
            let chunkSize = 100000; // Start with 100k blocks
            let failedAttempts = 0;
            
            // Process in chunks from block 10,000,000 (marketplace contract deployment)
            for (let startBlock = 10000000; startBlock < currentBlock; startBlock += chunkSize) {
                const endBlock = Math.min(startBlock + chunkSize - 1, currentBlock);
                
                try {
                    this.updateStatus(`Scanning blocks ${startBlock}-${endBlock} for transfers...`);
                    
                    const filter = isErc1155 ? {
                        topics: [eventTopic, null, null, walletTopic],
                        fromBlock: startBlock,
                        toBlock: endBlock
                    } : {
                        topics: [eventTopic, null, walletTopic],
                        fromBlock: startBlock,
                        toBlock: endBlock
                    };
                    
                    const logs = await this.provider.getLogs(filter);
                    
                    // Process logs and check for ERC20 vs NFT format
                    for (const log of logs) {
                        const contractAddr = log.address.toLowerCase();
                        
                        // Skip known ERC20s
                        if (this.knownErc20s.has(contractAddr)) continue;
                        
                        // For regular Transfer events, check if it has the tokenId topic
                        if (!isErc1155 && log.topics.length === 3) {
                            // This is likely an ERC20 (no indexed tokenId)
                            this.knownErc20s.add(contractAddr);
                            continue;
                        }
                        
                        // Otherwise add to contracts
                        contracts.add(contractAddr);
                    }
                    
                    this.updateStatus(`Found ${contracts.size} potential NFT contracts in blocks ${startBlock}-${endBlock}`);
                    
                    // If we succeeded, reset failure counter
                    failedAttempts = 0;
                } catch (error) {
                    failedAttempts++;
                    console.warn(`Error scanning blocks ${startBlock}-${endBlock}:`, error);
                    
                    // If multiple consecutive failures, adjust strategy
                    if (failedAttempts >= 3) {
                        console.warn(`Multiple failures, skipping ahead to recent blocks`);
                        // Skip ahead to more recent blocks
                        const recentStartBlock = Math.max(currentBlock - 1000000, startBlock + chunkSize);
                        if (recentStartBlock > startBlock) {
                            startBlock = recentStartBlock - chunkSize; // Will be incremented in next loop
                            failedAttempts = 0;
                            chunkSize = 50000; // Smaller chunk size for recent blocks
                            continue;
                        }
                    }
                    
                    // Reduce chunk size on error
                    if (chunkSize > 10000) {
                        const newChunkSize = Math.floor(chunkSize / 2);
                        console.log(`Reducing chunk size to ${newChunkSize} blocks`);
                        chunkSize = newChunkSize;
                        startBlock -= chunkSize; // Try this range again with smaller size
                    }
                }
            }
            
            // As a final fallback, check recent blocks specifically
            try {
                const recentStartBlock = Math.max(0, currentBlock - 100000);
                this.updateStatus(`Scanning recent blocks ${recentStartBlock}-${currentBlock} for transfers...`);
                
                const filter = isErc1155 ? {
                    topics: [eventTopic, null, null, walletTopic],
                    fromBlock: recentStartBlock,
                    toBlock: 'latest'
                } : {
                    topics: [eventTopic, null, walletTopic],
                    fromBlock: recentStartBlock,
                    toBlock: 'latest'
                };
                
                const logs = await this.provider.getLogs(filter);
                
                // Process logs with ERC20 filtering
                for (const log of logs) {
                    const contractAddr = log.address.toLowerCase();
                    
                    // Skip known ERC20s
                    if (this.knownErc20s.has(contractAddr)) continue;
                    
                    // For regular Transfer events, check if it has the tokenId topic
                    if (!isErc1155 && log.topics.length === 3) {
                        // This is likely an ERC20 (no indexed tokenId)
                        this.knownErc20s.add(contractAddr);
                        continue;
                    }
                    
                    // Otherwise add to contracts
                    contracts.add(contractAddr);
                }
                
                this.updateStatus(`Found ${contracts.size} potential NFT contracts in recent blocks`);
            } catch (e) {
                console.warn("Error scanning recent blocks:", e);
            }
            
        } catch (error) {
            console.error("Error in chunked transfer search:", error);
        }
    }

    // Improved detection of NFT standards
    async detectNFTStandard(contractAddress) {
        // Check cache first
        if (this.contractCache[contractAddress] && this.contractCache[contractAddress].type) {
            return this.contractCache[contractAddress].type;
        }
        
        try {
            // Try as ERC721
            const erc721Contract = new ethers.Contract(contractAddress, EXTENDED_ERC721_ABI, this.provider);
            
            try {
                // The most reliable way to detect ERC721
                const balance = await erc721Contract.balanceOf(this.walletAddress);
                if (balance > 0) {
                    this.contractCache[contractAddress] = { 
                        type: 'ERC721',
                        balance: Number(balance)
                    };
                    return 'ERC721';
                }
                
                // Even if balance is 0, it might still be an ERC721
                // Check if it has the ERC721 interface
                try {
                    const supportsERC721 = await erc721Contract.supportsInterface("0x80ac58cd");
                    if (supportsERC721) {
                        this.contractCache[contractAddress] = { type: 'ERC721', balance: 0 };
                        return 'ERC721';
                    }
                } catch (e) {
                    // Not confirmed as ERC721, try ERC1155
                }
            } catch (e) {
                // Not ERC721 or error occurred, try ERC1155
            }
            
            // Try as ERC1155
            const erc1155Contract = new ethers.Contract(contractAddress, EXTENDED_ERC1155_ABI, this.provider);
            
            try {
                // Try some common token IDs to see if we own any
                const testTokenIds = [1, 2, 3, 4, 5, 10, 100, 1000]; // Common token IDs
                let hasTokens = false;
                
                // Check each token ID individually (more reliable)
                for (const id of testTokenIds) {
                    try {
                        const balance = await erc1155Contract.balanceOf(this.walletAddress, id);
                        if (balance > 0) {
                            hasTokens = true;
                            break;
                        }
                    } catch (e) {
                        // Skip errors for individual tokens
                    }
                }
                
                if (hasTokens) {
                    this.contractCache[contractAddress] = { type: 'ERC1155' };
                    return 'ERC1155';
                }
                
                // Try batch balance check as fallback
                try {
                    const owners = testTokenIds.map(() => this.walletAddress);
                    const balances = await erc1155Contract.balanceOfBatch(owners, testTokenIds);
                    
                    if (balances.some(b => b > 0)) {
                        this.contractCache[contractAddress] = { type: 'ERC1155' };
                        return 'ERC1155';
                    }
                } catch (e) {
                    // Skip batch balance errors
                }
                
                // Check interface as last resort
                try {
                    const supportsERC1155 = await erc1155Contract.supportsInterface("0xd9b67a26");
                    if (supportsERC1155) {
                        this.contractCache[contractAddress] = { type: 'ERC1155' };
                        return 'ERC1155';
                    }
                } catch (e) {
                    // Not ERC1155 either
                }
            } catch (e) {
                // Not ERC1155
            }
            
            return null; // Not a recognized NFT contract
        } catch (error) {
            console.warn(`Error detecting NFT standard for ${contractAddress}:`, error);
            return null; // Not a standard NFT contract or error
        }
    }

    // Scan an ERC721 contract
    async scanERC721Contract(contractAddress) {
        try {
            const contract = new ethers.Contract(contractAddress, EXTENDED_ERC721_ABI, this.provider);
            let balance;
            
            try {
                balance = await contract.balanceOf(this.walletAddress);
                balance = Number(balance);
            } catch (e) {
                console.warn(`Error getting ERC721 balance for ${contractAddress}:`, e);
                return [];
            }
            
            if (balance === 0) return [];
            
            // Get contract info
            const contractInfo = await this.getContractInfo(contractAddress, 'ERC721');
            
            // Update total NFTs to scan
            this.updateProgress({ total: this.progress.total + balance });
            this.updateStatus(`Scanning ${contractInfo.name || contractAddress} (${balance} NFTs)`);
            
            const results = [];
            let enumerationErrors = 0;
            
            // Try first using enumerable extension (most reliable)
            try {
                for (let i = 0; i < balance; i++) {
                    try {
                        // Get token ID
                        const tokenId = await contract.tokenOfOwnerByIndex(this.walletAddress, i);
                        
                        // Get token URI if available
                        let tokenURI = null;
                        try {
                            tokenURI = await contract.tokenURI(tokenId);
                        } catch (e) {
                            // URI might not be available
                        }
                        
                        results.push({
                            contractAddress,
                            tokenId: tokenId.toString(),
                            type: 'ERC721',
                            tokenURI,
                            balance: '1'
                        });
                        
                        this.updateProgress({ found: this.progress.found + 1 });
                    } catch (e) {
                        enumerationErrors++;
                        // Only log first few errors to prevent console spam
                        if (enumerationErrors <= 2) {
                            console.warn(`Error with tokenOfOwnerByIndex for ${contractAddress} at index ${i}:`, e);
                        }
                        
                        // If we're getting too many enumeration errors, break out and try event approach
                        if (enumerationErrors > Math.min(5, balance / 2)) {
                            console.warn(`Too many enumeration errors (${enumerationErrors}), switching to event-based scanning`);
                            break;
                        }
                    }
                }
                
                // If we found some tokens but not the full balance, try event-based approach for the rest
                if (results.length > 0 && results.length < balance) {
                    const eventNFTs = await this.scanERC721ByEvents(contractAddress, contract, contractInfo, results);
                    results.push(...eventNFTs);
                }
                
                // If we found all tokens via enumeration, we're done
                if (results.length === balance) {
                    return results;
                }
            } catch (e) {
                // Contract doesn't support enumeration or has issues, try event-based approach
                console.warn(`Enumeration failed for ${contractAddress}, using events instead:`, e);
            }
            
            // If we get here, either enumeration failed completely or found only some tokens
            // Try event-based approach as fallback
            if (results.length < balance) {
                const eventResults = await this.scanERC721ByEvents(contractAddress, contract, contractInfo, results);
                results.push(...eventResults);
            }
            
            // If we still found nothing, try a sequential scan for common token IDs
            if (results.length === 0) {
                const sequentialResults = await this.scanERC721SequentialIds(contractAddress, contract, contractInfo);
                results.push(...sequentialResults);
            }
            
            return results;
        } catch (error) {
            console.error(`Error in ERC721 scan for ${contractAddress}:`, error);
            return [];
        }
    }
    
    // Scan ERC721 using Transfer events 
    async scanERC721ByEvents(contractAddress, contract, contractInfo, existingResults = []) {
        const results = [];
        
        try {
            // Track token IDs we've already found via enumeration to avoid duplicates
            const foundTokenIds = new Set(existingResults.map(nft => nft.tokenId));
            
            // Get all Transfer events TO this wallet (from block 0)
            const transferTopic = ethers.id('Transfer(address,address,uint256)');
            const toWalletTopic = ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32);
            
            // Try to find all transfers to this user
            try {
                // Start from block 10,000,000 (marketplace contract deployment)
                const allTransfers = [];
                let startBlock = 10000000;
                const currentBlock = await this.provider.getBlockNumber();
                let chunkSize = 500000; // 500k blocks at a time
                
                while (startBlock <= currentBlock) {
                    const endBlock = Math.min(startBlock + chunkSize - 1, currentBlock);
                    
                    try {
                        const filter = {
                            address: contractAddress,
                            topics: [transferTopic, null, toWalletTopic],
                            fromBlock: startBlock,
                            toBlock: endBlock
                        };
                        
                        const logs = await this.provider.getLogs(filter);
                        allTransfers.push(...logs);
                        
                        startBlock = endBlock + 1;
                    } catch (e) {
                        console.warn(`Error getting logs from blocks ${startBlock}-${endBlock}, reducing chunk size`);
                        if (chunkSize > 50000) {
                            // Reduce chunk size and try again
                            const newChunkSize = Math.floor(chunkSize / 2);
                            console.log(`Reducing chunk size to ${newChunkSize} blocks`);
                            const chunkSizeSave = chunkSize;
                            chunkSize = newChunkSize;
                            startBlock = Math.max(0, endBlock - chunkSizeSave + chunkSize + 1);
                        } else {
                            // If chunk size is already small, just move on
                            startBlock = endBlock + 1;
                        }
                    }
                }
                
                // Extract unique token IDs from all transfers - WITH SAFETY CHECKS
                const tokenIds = new Set();
                for (const log of allTransfers) {
                    if (log.topics.length === 4 && log.topics[3] !== null) {
                        try {
                            // This looks like an NFT transfer (has indexed tokenId)
                            const tokenId = ethers.toBigInt(log.topics[3]);
                            tokenIds.add(tokenId.toString());
                        } catch (e) {
                            console.warn(`Error extracting token ID from log:`, e);
                        }
                    }
                }
                
                this.updateStatus(`Found ${tokenIds.size} potential token IDs from events`);
                
                // Check each token ID to see if we still own it
                for (const tokenId of tokenIds) {
                    // Skip tokens we already found via enumeration
                    if (foundTokenIds.has(tokenId)) continue;
                    
                    try {
                        const owner = await contract.ownerOf(tokenId);
                        if (owner.toLowerCase() === this.walletAddress.toLowerCase()) {
                            // We own this token
                            let tokenURI = null;
                            try {
                                tokenURI = await contract.tokenURI(tokenId);
                            } catch (e) {
                                // URI might not be available
                            }
                            
                            results.push({
                                contractAddress,
                                tokenId: tokenId.toString(),
                                type: 'ERC721',
                                tokenURI,
                                balance: '1'
                            });
                            
                            this.updateProgress({ found: this.progress.found + 1 });
                        }
                    } catch (e) {
                        // We don't own this token anymore or error accessing it
                    }
                }
            } catch (logError) {
                console.error(`Error scanning transfer events for ${contractAddress}:`, logError);
            }
        } catch (error) {
            console.error(`Error in event-based scan for ${contractAddress}:`, error);
        }
        
        return results;
    }
    
    // Try sequential IDs as last resort
    async scanERC721SequentialIds(contractAddress, contract, contractInfo) {
        const results = [];
        
        try {
            this.updateStatus(`Trying sequential token IDs for ${contractInfo.name}...`);
            
            // Try to get totalSupply as upper bound
            let maxToCheck = 10000; // Default limit
            
            try {
                const totalSupply = await contract.totalSupply();
                maxToCheck = Math.min(Number(totalSupply) * 2, 20000); // Double the supply as safety margin
            } catch (e) {
                // totalSupply not available, use default
            }
            
            // Create list of IDs to check
            const idsToCheck = [];
            
            // Try sequential IDs in ascending order
            for (let id = 1; id <= maxToCheck; id += id < 100 ? 1 : id < 1000 ? 10 : 100) {
                idsToCheck.push(id);
            }
            
            // Add some powers of 10 and powers of 2
            for (let i = 0; i <= 10; i++) idsToCheck.push(10 ** i);
            for (let i = 0; i <= 16; i++) idsToCheck.push(2 ** i);
            
            // Check each ID
            for (const id of [...new Set(idsToCheck)]) {
                try {
                    const owner = await contract.ownerOf(id);
                    if (owner.toLowerCase() === this.walletAddress.toLowerCase()) {
                        // We own this token
                        let tokenURI = null;
                        try {
                            tokenURI = await contract.tokenURI(id);
                        } catch (e) {
                            // URI might not be available
                        }
                        
                        results.push({
                            contractAddress,
                            tokenId: id.toString(),
                            type: 'ERC721',
                            tokenURI,
                            balance: '1'
                        });
                        
                        this.updateProgress({ found: this.progress.found + 1 });
                    }
                } catch (e) {
                    // Not our token or doesn't exist
                }
            }
        } catch (error) {
            console.error(`Error in sequential ID scan for ${contractAddress}:`, error);
        }
        
        return results;
    }

    // Scan an ERC1155 contract
    async scanERC1155Contract(contractAddress) {
        try {
            const contract = new ethers.Contract(contractAddress, EXTENDED_ERC1155_ABI, this.provider);
            const contractInfo = await this.getContractInfo(contractAddress, 'ERC1155');
            
            this.updateStatus(`Scanning ${contractInfo.name || contractAddress} (ERC1155)...`);
            
            // Find ALL token IDs for this contract
            const tokenIds = await this.discoverERC1155TokenIds(contract, contractAddress);
            
            if (tokenIds.length === 0) {
                return [];
            }
            
            this.updateProgress({ total: this.progress.total + tokenIds.length });
            this.updateStatus(`Checking ${tokenIds.length} token IDs in ${contractInfo.name}`);
            
            const results = [];
            let processedCount = 0;
            
            // Process tokens in batches to reduce RPC calls
            const batchSize = 20;
            
            for (let i = 0; i < tokenIds.length; i += batchSize) {
                const batch = tokenIds.slice(i, i + batchSize);
                
                try {
                    // Try batch balance check
                    const owners = batch.map(() => this.walletAddress);
                    const balances = await contract.balanceOfBatch(owners, batch);
                    
                    // Process results
                    for (let j = 0; j < batch.length; j++) {
                        const tokenId = batch[j];
                        const balance = balances[j];
                        
                        processedCount++;
                        
                        if (balance > 0) {
                            // Get token URI if possible
                            let tokenURI = null;
                            try {
                                tokenURI = await contract.uri(tokenId);
                                // Replace {id} with tokenId if present
                                if (tokenURI && tokenURI.includes('{id}')) {
                                  // Convert to hex and pad to 64 chars
                                  const hex = BigInt(tokenId).toString(16).padStart(64, '0');
                                  tokenURI = tokenURI.replace('{id}', hex);
                                }
                            } catch (e) {
                                // URI might not be available
                            }
                            
                            results.push({
                                contractAddress,
                                tokenId: tokenId.toString(),
                                type: 'ERC1155',
                                tokenURI,
                                balance: balance.toString()
                            });
                            
                            this.updateProgress({ found: this.progress.found + 1 });
                        }
                    }
                } catch (e) {
                    // Batch call failed, try individual calls
                    console.warn(`Batch balance check failed for ${contractInfo.name}, trying individual calls`);
                    
                    for (const tokenId of batch) {
                        try {
                            const balance = await contract.balanceOf(this.walletAddress, tokenId);
                            
                            processedCount++;
                            
                            if (balance > 0) {
                                // Get token URI if possible
                                let tokenURI = null;
                                try {
                                    tokenURI = await contract.uri(tokenId);
                                } catch (e) {
                                    // URI might not be available
                                }
                                
                                results.push({
                                    contractAddress,
                                    tokenId: tokenId.toString(),
                                    type: 'ERC1155',
                                    tokenURI,
                                    balance: balance.toString()
                                });
                                
                                this.updateProgress({ found: this.progress.found + 1 });
                            }
                        } catch (e) {
                            // Skip error for this token
                            processedCount++;
                        }
                    }
                }
                
                // Update scan progress
                this.updateProgress({ scanned: this.progress.scanned + (processedCount / tokenIds.length) });
                
                // Report progress periodically
                if (i % 100 === 0 || i + batchSize >= tokenIds.length) {
                    this.updateStatus(`Checked ${Math.min(i + batchSize, tokenIds.length)}/${tokenIds.length} token IDs in ${contractInfo.name}, found ${results.length} NFTs`);
                }
            }
            
            return results;
        } catch (error) {
            console.error(`Error in ERC1155 scan for ${contractAddress}:`, error);
            return [];
        }
    }

    // Discover ERC1155 token IDs 
    async discoverERC1155TokenIds(contract, contractAddress) {
        try {
            const tokenIds = new Set();
            
            // Scan from block 10,000,000 (marketplace contract deployment)
            const fromBlock = 10000000;
            const toBlock = 'latest';
            
            try {
                // Try to query all events at once
                try {
                    // TransferSingle events
                    const singleFilter = contract.filters.TransferSingle(null, null, this.walletAddress);
                    const singleEvents = await contract.queryFilter(singleFilter, fromBlock, toBlock);
                    
                    singleEvents.forEach(event => {
                        tokenIds.add(event.args.id.toString());
                    });
                    
                    // TransferBatch events
                    const batchFilter = contract.filters.TransferBatch(null, null, this.walletAddress);
                    const batchEvents = await contract.queryFilter(batchFilter, fromBlock, toBlock);
                    
                    batchEvents.forEach(event => {
                        event.args.ids.forEach(id => tokenIds.add(id.toString()));
                    });
                    
                    this.updateStatus(`Found ${tokenIds.size} potential token IDs from events`);
                } catch (error) {
                    // Full event query might be too large, try chunking
                    this.updateStatus(`Event query too large, trying chunks...`);
                    await this.findERC1155TokenIdsByChunks(contract, contractAddress, tokenIds);
                }
            } catch (error) {
                console.warn(`Error getting events for ${contractAddress}, trying brute force:`, error);
                
                // Add a wide range of token IDs to check
                this.updateStatus("Using brute force token ID discovery...");
                
                // Sequential IDs from 0 to 1000
                for (let i = 0; i <= 1000; i++) {
                    tokenIds.add(i.toString());
                }
                
                // Powers of 10
                for (let i = 0; i <= 10; i++) {
                    tokenIds.add(Math.pow(10, i).toString());
                }
                
                // Powers of 2
                for (let i = 0; i <= 30; i++) {
                    tokenIds.add(Math.pow(2, i).toString());
                }
            }
            
            // If the set is still empty, add common token IDs as fallback
            if (tokenIds.size === 0) {
                for (let i = 0; i <= 1000; i += 10) {
                    tokenIds.add(i.toString());
                }
            }
            
            return [...tokenIds];
        } catch (error) {
            console.error(`Error discovering ERC1155 token IDs for ${contractAddress}:`, error);
            
            // Return some common token IDs as fallback
            const commonIds = [];
            for (let i = 0; i <= 1000; i += 10) commonIds.push(i.toString());
            return commonIds;
        }
    }
    
    // Find ERC1155 token IDs by chunking
    async findERC1155TokenIdsByChunks(contract, contractAddress, tokenIds) {
        try {
            const currentBlock = await this.provider.getBlockNumber();
            const chunkSize = 100000; // 100k blocks at a time
            
            // Process in chunks from block 10,000,000 (marketplace contract deployment)
            for (let startBlock = 10000000; startBlock < currentBlock; startBlock += chunkSize) {
                const endBlock = Math.min(startBlock + chunkSize - 1, currentBlock);
                
                try {
                    this.updateStatus(`Scanning blocks ${startBlock}-${endBlock} for ERC1155 tokens...`);
                    
                    // TransferSingle events
                    try {
                        const singleFilter = contract.filters.TransferSingle(null, null, this.walletAddress);
                        const singleEvents = await contract.queryFilter(singleFilter, startBlock, endBlock);
                        
                        singleEvents.forEach(event => {
                            tokenIds.add(event.args.id.toString());
                        });
                    } catch (e) {
                        console.warn(`Error getting TransferSingle events in blocks ${startBlock}-${endBlock}:`, e);
                    }
                    
                    // TransferBatch events
                    try {
                        const batchFilter = contract.filters.TransferBatch(null, null, this.walletAddress);
                        const batchEvents = await contract.queryFilter(batchFilter, startBlock, endBlock);
                        
                        batchEvents.forEach(event => {
                            event.args.ids.forEach(id => tokenIds.add(id.toString()));
                        });
                    } catch (e) {
                        console.warn(`Error getting TransferBatch events in blocks ${startBlock}-${endBlock}:`, e);
                    }
                } catch (error) {
                    console.warn(`Error scanning blocks ${startBlock}-${endBlock} for ERC1155 tokens:`, error);
                }
            }
        } catch (error) {
            console.error(`Error in chunked ERC1155 token ID discovery:`, error);
        }
    }

    // Get contract info (name & symbol)
    async getContractInfo(contractAddress, contractType) {
        // Check cache
        if (this.contractCache[contractAddress] && 
            this.contractCache[contractAddress].name !== undefined) {
            return this.contractCache[contractAddress];
        }
        
        try {
            const abi = contractType === 'ERC721' ? EXTENDED_ERC721_ABI : EXTENDED_ERC1155_ABI;
            const contract = new ethers.Contract(contractAddress, abi, this.provider);
            
            let name = '', symbol = '';
            
            // Try to get name
            try {
                name = await contract.name();
            } catch (e) {
                name = `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;
            }
            
            // Try to get symbol
            try {
                symbol = await contract.symbol();
            } catch (e) {
                // Symbol not available
            }
            
            const info = { name, symbol, type: contractType };
            
            // Cache the result
            this.contractCache[contractAddress] = info;
            
            return info;
        } catch (error) {
            console.warn(`Error getting contract info for ${contractAddress}:`, error);
            const fallbackName = `Collection ${contractAddress.slice(0, 6)}...${contractAddress.slice(-4)}`;
            
            // Cache the fallback result
            this.contractCache[contractAddress] = { 
                name: fallbackName, 
                symbol: '', 
                type: contractType 
            };
            
            return { name: fallbackName, symbol: '', type: contractType };
        }
    }

    // Get metadata with caching and lazy loading support
    async getMetadata(contractAddress, tokenId, tokenURI) {
        // Check cache first
        const cachedMetadata = this.getCachedMetadata(contractAddress, tokenId);
        if (cachedMetadata) {
            return cachedMetadata;
        }
        
        // Not in cache, fetch it
        try {
            if (!tokenURI) {
                // No URI, use fallback
                const fallbackMetadata = this.createFallbackMetadata(contractAddress, tokenId);
                this.cacheMetadata(contractAddress, tokenId, fallbackMetadata);
                return fallbackMetadata;
            }

            // Handle URI formats and cleanup
            let resolvedUri = tokenURI;

            // Replace {id} with tokenId in various formats
            resolvedUri = resolvedUri.replace(/{id}/g, tokenId)
                .replace(/{tokenId}/g, tokenId)
                .replace(/\{id\}/g, tokenId);

            // Handle IPFS URIs
            if (resolvedUri.startsWith('ipfs://')) {
                resolvedUri = `https://cloudflare-ipfs.com/ipfs/${resolvedUri.replace('ipfs://', '')}`;
            }

            // Try to fetch with a timeout
            const response = await this.fetchWithTimeout(resolvedUri, {
                headers: { 'Accept': 'application/json' }
            }, 10000);
            
            if (response.ok) {
                const metadata = await response.json();
                
                // Process and normalize
                let imageUrl = null;
                
                // Handle image field formats
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
                
                // Get attributes
                const attributes = metadata.attributes || metadata.traits || [];
                
                // Create normalized metadata
                const normalizedMetadata = {
                    name: metadata.name || `NFT #${tokenId}`,
                    description: metadata.description || '',
                    imageUrl,
                    attributes,
                    loaded: true,
                    loading: false,
                    error: null
                };
                
                // Cache it
                this.cacheMetadata(contractAddress, tokenId, normalizedMetadata);
                
                return normalizedMetadata;
            }
            
            // Failed to fetch, use fallback
            const fallbackMetadata = this.createFallbackMetadata(contractAddress, tokenId);
            this.cacheMetadata(contractAddress, tokenId, fallbackMetadata);
            return fallbackMetadata;
            
        } catch (error) {
            console.warn(`Error fetching metadata for ${contractAddress} token ${tokenId}:`, error);
            
            // Use fallback on error
            const fallbackMetadata = this.createFallbackMetadata(contractAddress, tokenId);
            this.cacheMetadata(contractAddress, tokenId, fallbackMetadata);
            return fallbackMetadata;
        }
    }
    
    // Utility for fetch with timeout
    async fetchWithTimeout(url, options = {}, timeout = 10000) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);
        
        try {
            const response = await fetch(url, {
                ...options,
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }
    
    // Create fallback metadata when fetching fails
    createFallbackMetadata(contractAddress, tokenId) {
        const fallbackImg = this.generateFallbackImage(contractAddress, tokenId);
        
        return {
            name: `NFT #${tokenId}`,
            description: 'Metadata unavailable',
            imageUrl: fallbackImg,
            attributes: [],
            loaded: true,
            loading: false,
            error: 'Could not fetch metadata'
        };
    }
    
    // Generate a deterministic fallback image
    generateFallbackImage(contractAddress, tokenId) {
        const hash = contractAddress.toLowerCase() + tokenId.toString();
        let hashNum = 0;
        
        for (let i = 0; i < hash.length; i++) {
            hashNum = ((hashNum << 5) - hashNum) + hash.charCodeAt(i);
            hashNum = hashNum & hashNum; // Convert to 32bit integer
        }
        
        // Generate HSL color
        const h = Math.abs(hashNum) % 360;
        const s = 70 + (Math.abs(hashNum >> 8) % 30); // 70-100%
        const l = 40 + (Math.abs(hashNum >> 16) % 20); // 40-60%
        
        // Convert to hex
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
        
        return `https://via.placeholder.com/300/${hslToHex(h, s, l)}/FFFFFF?text=${tokenId}`;
    }

    // The rest of the methods remain the same as in your implementation, but
    // I'd recommend adding the following helper method to do lazy metadata loading:
    
    /**
     * Lazy load metadata for a batch of NFTs
     * @param {Array} nfts - NFTs to load metadata for
     * @param {Number} batchSize - Number of NFTs to process in parallel
     * @returns {Promise} Promise that resolves when all metadata is loaded
     */
    async lazyLoadMetadata(nfts, batchSize = 5) {
        // Group NFTs by those that need metadata loading
        const nftsToFetch = nfts.filter(nft => {
            // Skip if we have cached metadata already
            return !this.getCachedMetadata(nft.contractAddress, nft.tokenId);
        });
        
        if (nftsToFetch.length === 0) return;
        
        console.log(`Lazy loading metadata for ${nftsToFetch.length} NFTs`);
        
        // Process in smaller batches to avoid overwhelming network
        for (let i = 0; i < nftsToFetch.length; i += batchSize) {
            const batch = nftsToFetch.slice(i, i + batchSize);
            
            // Process batch in parallel
            await Promise.all(
                batch.map(nft => 
                    this.getMetadata(nft.contractAddress, nft.tokenId, nft.tokenURI)
                        .catch(err => console.warn(`Error loading metadata for token ${nft.tokenId}:`, err))
                )
            );
            
            // Small delay between batches
            if (i + batchSize < nftsToFetch.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
        
        console.log(`Completed loading metadata for ${nftsToFetch.length} NFTs`);
    }

    // Add this static method to your NFTScanner class
    static getDisclaimer() {
        return {
            title: "NFT Scanning Process",
            message: "Loading NFTs may take several minutes as we scan the entire blockchain history to find all your tokens. This thorough scanning ensures we find older NFTs that other viewers might miss.",
            tips: [
                "Recently acquired NFTs will appear first",
                "Cached results will load instantly on future visits",
                "You can continue browsing while scanning runs in the background"
            ]
        };
    }
}