import { ethers } from 'ethers';
import { debugLog, debugWarn, criticalError } from './debugUtils';

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

// Add well-known NFT contracts to force-scan - EXPANDED LIST for comprehensive coverage
const KNOWN_NFT_CONTRACTS = [
    '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906', // Pixel Ninja Cats
    '0x0BE8E03C7cf2F880cD6968E355feae724aB9b5AE', // VMonsters
    '0x0e4a2D78658aF51800852ca67181B57Bac401F13', // vdex v3
    '0xE1A5518CEbd226FE2a3251F93A1F6AAef65d3131', // Skoollz
    '0x30dA83269Da1Dfe17253Bf07F92056c2adCcA453', // CrocoDeal 404
    '0x89207A7F75C9cb7C8f95f0c2517b029BE1AE29b8', // NeonKatz

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
        
        // Validate and normalize wallet address
        try {
            this.walletAddress = ethers.getAddress(walletAddress.toLowerCase());
        } catch (e) {
            throw new Error(`Invalid wallet address: ${walletAddress}`);
        }
        
        this.updateStatus = statusCallback || (() => {});
        this.progress = { found: 0, scanned: 0, total: 0 };
        this.nfts = [];
        this.contractCache = this.loadContractCache();
        this.errors = {}; // Track errors per contract
        this.knownErc20s = new Set([...KNOWN_ERC20_CONTRACTS.map(addr => addr.toLowerCase())]);
        this.loadKnownErc20s();
        this.metadataCache = this.loadMetadataCache();
        this.cachedNfts = null;
        this.scanStartTime = null; // Track scan timing
        
        // Background scanning state
        this.isBackgroundScanning = false;
        this.backgroundScanPromise = null;
        
        // Add validation for provider
        if (!provider) {
            throw new Error('Provider is required for NFT scanning');
        }
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
            debugWarn('Error loading cached NFTs:', e);
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
            debugWarn('Error saving NFTs to cache:', e);
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
            debugWarn('Error loading contract cache:', e);
        }
        
        return {};
    }

    // Save contract cache
    saveContractCache() {
        try {
            localStorage.setItem('nft_contract_cache', JSON.stringify(this.contractCache));
        } catch (e) {
            debugWarn('Error saving contract cache:', e);
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
            debugWarn('Error loading known ERC20 tokens:', e);
        }
    }

    // Save known ERC20 tokens
    saveKnownErc20s() {
        try {
            localStorage.setItem('known_erc20_tokens', 
                JSON.stringify([...this.knownErc20s]));
        } catch (e) {
            debugWarn('Error saving known ERC20 tokens:', e);
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
            debugWarn('Error loading metadata cache:', e);
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
            debugWarn('Error saving metadata cache:', e);
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

    // Update progress and report with enhanced feedback
    updateProgress(updates) {
        this.progress = { ...this.progress, ...updates };
        
        // Calculate scanning rate for better user feedback
        const elapsed = Date.now() - (this.scanStartTime || Date.now());
        const rate = this.progress.scanned > 0 ? (this.progress.scanned / (elapsed / 1000)).toFixed(1) : 0;
        
        // Estimate time remaining
        const remaining = this.progress.total > this.progress.scanned ? 
            ((this.progress.total - this.progress.scanned) / rate) : 0;
        const etaText = remaining > 0 && remaining < 3600 ? ` (ETA: ${Math.ceil(remaining)}s)` : '';
        
        this.updateStatus(`🔍 Found ${this.progress.found} NFTs | Scanned ${this.progress.scanned}/${this.progress.total || '?'} | ${rate}/s${etaText}`);
    }

    // Get all NFTs with caching support
    async getAllNFTs(forceRefresh = false, scanFromGenesis = false) {
        // First try to use cached NFTs (unless scanning from genesis is specifically requested)
        if (!forceRefresh && !scanFromGenesis) {
            const cachedNfts = this.loadCachedNfts();
            if (cachedNfts) {
                this.nfts = cachedNfts;
                this.updateStatus(`Loaded ${cachedNfts.length} NFTs from cache`);
                
                // Start background refresh if needed
                this.startBackgroundScan();
                
                return cachedNfts;
            }
        }
        
        // No valid cache or comprehensive scan requested, do a full scan
        const nfts = await this.scanAllNFTs(false, scanFromGenesis);
        
        // Save to cache
        this.saveNftsToCache(nfts);
        
        return nfts;
    }

    // NEW: Enhanced contract discovery for Vitruveo blockchain
    async discoverNFTContractsForVitruveoBlockchain(scanFromGenensis = false) {
        const discoveredContracts = new Set();
        
        try {
            const currentBlock = await this.provider.getBlockNumber();
            const fromBlock = scanFromGenensis ? 0 : Math.max(0, currentBlock - 200000); // 200k blocks for good coverage
            
            this.updateStatus(`🔍 Discovering NFT contracts on Vitruveo blockchain...`);
            
            // Focus on Vitruveo marketplace and local contracts
            const VITRUVEO_MARKETPLACE_CONTRACTS = [
                process.env.VITE_MARKETPLACE_ADDRESS, // Our own marketplace
                // Add other known Vitruveo marketplace contracts here as they're discovered
            ].filter(addr => addr && addr !== '0x0000000000000000000000000000000000000000');

            // Scan our own marketplace for NFT contract activity
            for (const marketplaceAddr of VITRUVEO_MARKETPLACE_CONTRACTS) {
                if (!marketplaceAddr) continue;
                
                try {
                    // Look for Transfer events from/to our wallet around marketplace activity
                    const transferTopic = ethers.id('Transfer(address,address,uint256)');
                    const walletTopic = ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32);
                    
                    const filter = {
                        topics: [transferTopic, null, walletTopic], // Transfers TO our wallet
                        fromBlock: fromBlock,
                        toBlock: 'latest'
                    };

                    const logs = await this.provider.getLogs(filter);
                    
                    // Parse logs to extract NFT contract addresses
                    for (const log of logs) {
                        // The contract address of the transfer is likely an NFT contract
                        const contractAddr = log.address.toLowerCase();
                        
                        // Skip known ERC20s and the marketplace itself
                        if (!this.knownErc20s.has(contractAddr) && 
                            contractAddr !== marketplaceAddr.toLowerCase()) {
                            discoveredContracts.add(contractAddr);
                        }
                    }
                    
                } catch (marketplaceError) {
                    debugLog(`Error scanning Vitruveo marketplace ${marketplaceAddr}: ${marketplaceError.message}`);
                }
                
                // Small delay between marketplace scans
                await new Promise(r => setTimeout(r, 100));
            }

            // Also look for ERC721/ERC1155 approval events (ApprovalForAll) 
            try {
                const approvalTopic = ethers.id('ApprovalForAll(address,address,bool)');
                const walletTopic = ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32);
                
                const approvalFilter = {
                    topics: [approvalTopic, walletTopic], // Events where our wallet approved someone
                    fromBlock: fromBlock,
                    toBlock: 'latest'
                };

                const approvalLogs = await this.provider.getLogs(approvalFilter);
                
                // The contract address of these events are NFT contracts we've interacted with
                for (const log of approvalLogs) {
                    if (!this.knownErc20s.has(log.address.toLowerCase())) {
                        discoveredContracts.add(log.address.toLowerCase());
                    }
                }
                
            } catch (approvalError) {
                debugLog(`Error scanning approval events: ${approvalError.message}`);
            }
            
            const contractsArray = Array.from(discoveredContracts);
            this.updateStatus(`🎯 Discovered ${contractsArray.length} potential NFT contracts on Vitruveo blockchain`);
            
            return contractsArray;
            
        } catch (error) {
            debugWarn(`Error in Vitruveo contract discovery: ${error.message}`);
            return [];
        }
    }

    // NEW: Final ownership verification to ensure we only return currently owned NFTs
    async verifyNFTOwnership(nfts) {
        const verifiedNfts = [];
        const totalToVerify = nfts.length;
        let verified = 0;
        
        this.updateStatus(`🔒 Verifying ownership of ${totalToVerify} NFTs...`);
        
        // Process in batches to avoid overwhelming the RPC
        const batchSize = 15;
        for (let i = 0; i < nfts.length; i += batchSize) {
            const batch = nfts.slice(i, i + batchSize);
            
            const verificationPromises = batch.map(async (nft) => {
                try {
                    const { contractAddress, tokenId, type } = nft;
                    
                    if (type === 'ERC721') {
                        // For ERC721, check ownerOf
                        const contract = new ethers.Contract(contractAddress, EXTENDED_ERC721_ABI, this.provider);
                        const ownerPromise = contract.ownerOf(tokenId);
                        const timeoutPromise = new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('ownerOf timeout')), 8000)
                        );
                        
                        const owner = await Promise.race([ownerPromise, timeoutPromise]);
                        if (owner.toLowerCase() === this.walletAddress.toLowerCase()) {
                            return nft; // We still own this NFT
                        }
                    } else if (type === 'ERC1155') {
                        // For ERC1155, check balanceOf
                        const contract = new ethers.Contract(contractAddress, EXTENDED_ERC1155_ABI, this.provider);
                        const balancePromise = contract.balanceOf(this.walletAddress, tokenId);
                        const timeoutPromise = new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('balanceOf timeout')), 8000)
                        );
                        
                        const balance = await Promise.race([balancePromise, timeoutPromise]);
                        if (Number(balance) > 0) {
                            // Update the balance in case it changed
                            return { ...nft, balance: balance.toString() };
                        }
                    }
                    
                    // If we get here, we don't own this NFT anymore
                    return null;
                    
                } catch (error) {
                    // If verification fails, assume we don't own it (safer approach)
                    if (!error.message.includes('execution reverted') && 
                        !error.message.includes('timeout')) {
                        debugLog(`Ownership verification failed for ${nft.contractAddress}:${nft.tokenId} - ${error.message}`);
                    }
                    return null;
                }
            });
            
            const batchResults = await Promise.allSettled(verificationPromises);
            
            for (const result of batchResults) {
                if (result.status === 'fulfilled' && result.value) {
                    verifiedNfts.push(result.value);
                }
                verified++;
            }
            
            // Update progress
            this.updateStatus(`🔒 Verified ownership: ${verified}/${totalToVerify} NFTs (${verifiedNfts.length} confirmed owned)`);
            
            // Small delay between batches
            if (i + batchSize < nfts.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
        
        const removedCount = totalToVerify - verifiedNfts.length;
        if (removedCount > 0) {
            this.updateStatus(`✅ Ownership verified: ${verifiedNfts.length} NFTs confirmed (${removedCount} no longer owned)`);
            debugLog(`🔒 Removed ${removedCount} NFTs that are no longer owned`);
        } else {
            this.updateStatus(`✅ All ${verifiedNfts.length} NFTs confirmed as currently owned`);
        }
        
        return verifiedNfts;
    }
    
    // Smart background scan with rate limiting for production use
    startBackgroundScan() {
        // Check if we should do a smart background refresh
        const lastScan = localStorage.getItem('nft_last_background_scan');
        const BACKGROUND_SCAN_COOLDOWN = 10 * 60 * 1000; // 10 minutes minimum between scans
        
        if (lastScan && (Date.now() - parseInt(lastScan)) < BACKGROUND_SCAN_COOLDOWN) {
            debugLog("⏱️ Background scan skipped - still in cooldown period");
            return;
        }
        
        // Only scan if we have a reasonable number of cached NFTs (not overwhelming)
        if (this.nfts.length > 100) {
            debugLog("⚠️ Background scan skipped - too many NFTs to scan efficiently");
            return;
        }
        
        // Start a conservative background refresh
        setTimeout(async () => {
            try {
                debugLog("🔄 Starting smart background NFT refresh...");
                localStorage.setItem('nft_last_background_scan', Date.now().toString());
                
                // Only scan recent blocks for new NFTs, not full history
                const recentNfts = await this.scanAllNFTs(false, false);
                
                // Only update if we found new NFTs
                if (recentNfts.length > this.nfts.length) {
                    this.nfts = recentNfts;
                    this.saveNftsToCache(recentNfts);
                    this.updateStatus(`Found ${recentNfts.length - this.nfts.length} new NFTs`);
                    debugLog(`✅ Background scan complete - found ${recentNfts.length - this.nfts.length} new NFTs`);
                } else {
                    debugLog("📋 Background scan complete - no new NFTs found");
                }
            } catch (error) {
                debugWarn("❌ Background scan failed:", error);
            }
        }, 5000); // Start after 5 seconds delay
    }

    // FIXED: Smart scanning - conservative by default, comprehensive only when requested
    async scanAllNFTs(isBackground = false, scanFromGenesis = false) {
        try {
            // Start timing for performance tracking
            this.scanStartTime = Date.now();
            
            // Reset progress
            this.progress = { found: 0, scanned: 0, total: 0 };
            
            // Start with known contracts + contract discovery
            let contractsToScan = [...KNOWN_NFT_CONTRACTS];
            
            // FIXED: Smart scanning approach based on actual parameter
            if (scanFromGenesis) {
                debugLog(`🔍 DEBUG: scanAllNFTs called with COMPREHENSIVE scanning (genesis)`);
                this.updateStatus("🔍 Comprehensive NFT scanning from blockchain genesis (block 0)");
                debugLog("🌐 Comprehensive NFT discovery from all blockchain history");
                debugLog("💡 Scanning known contracts + complete blockchain history for maximum coverage");
            } else {
                debugLog(`🔍 DEBUG: scanAllNFTs called with SMART scanning (recent blocks)`);
                this.updateStatus("🔍 Smart NFT scanning from recent blockchain activity");
                debugLog("🌐 Smart NFT discovery from recent blockchain activity (last 50k blocks)");
                debugLog("💡 Scanning known contracts + recent blockchain history for fast performance");
            }
            
            // Add contracts from transfer discovery (respecting scanFromGenesis)
            this.updateStatus(scanFromGenesis ? 
                "🔍 Discovering NFT contracts from complete blockchain history..." :
                "🔍 Discovering NFT contracts from recent blockchain activity...");
            
            let recentContracts = [];
            try {
                // FIXED: Pass the actual parameter instead of forcing true
                recentContracts = await this.findContractsByRecentTransfers(scanFromGenesis);
            } catch (error) {
                debugWarn("Main contract discovery failed, using fallback method:", error);
                // Fallback to the method that respects scanFromGenesis flag
                try {
                    // FIXED: Pass the actual parameter instead of forcing true
                    recentContracts = await this.findContractsByRecentTransfersFallback(scanFromGenesis);
                } catch (fallbackError) {
                    criticalError("Fallback contract discovery also failed:", fallbackError);
                    recentContracts = []; // Continue with known contracts only
                }
            }
            contractsToScan.push(...recentContracts);

            // NEW: Add Vitruveo blockchain contract discovery for enhanced coverage
            let vitruveoContracts = [];
            try {
                this.updateStatus("🎯 Discovering NFT contracts on Vitruveo blockchain...");
                vitruveoContracts = await this.discoverNFTContractsForVitruveoBlockchain(scanFromGenesis);
                contractsToScan.push(...vitruveoContracts);
                debugLog(`🎯 Added ${vitruveoContracts.length} contracts from Vitruveo discovery`);
            } catch (vitruveoError) {
                debugWarn("Vitruveo contract discovery failed:", vitruveoError);
                // Continue without additional discovery
            }
            
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
            
            const scanType = scanFromGenesis ? 'comprehensive genesis' : 'smart recent';
            this.updateStatus(`🎯 Found ${contractsToScan.length} contracts to scan - ${scanType} approach`);
            
            // Save contract cache and known ERC20s periodically
            const saveInterval = setInterval(() => {
                this.saveContractCache();
                this.saveKnownErc20s();
            }, 15000);
            
            // Gather all NFTs with the chosen approach
            const allNfts = [];
            
            // Process in small sequential batches to reduce load
            const batchSize = isBackground ? 1 : 2;
            
            try {
                for (let i = 0; i < contractsToScan.length; i += batchSize) {
                    const batch = contractsToScan.slice(i, i + batchSize);
                    
                    // Process contracts sequentially with comprehensive error handling
                    for (const address of batch) {
                        try {
                            // FIXED: Pass the actual scanFromGenesis parameter
                            const nfts = await this.scanSingleContract(address, scanFromGenesis);
                            allNfts.push(...nfts);
                            
                            // Update progress
                            this.updateProgress({ 
                                found: this.progress.found + nfts.length,
                                scanned: this.progress.scanned + 1 
                            });
                        } catch (e) {
                            // Comprehensive error handling - don't let individual contract errors stop the scan
                            if (e.message.includes('execution reverted') || 
                                e.message.includes('call revert exception') ||
                                e.message.includes('Internal JSON-RPC error') ||
                                e.message.includes('missing revert data') ||
                                e.code === -32603 || e.code === -32000 || e.code === 'CALL_EXCEPTION') {
                                // Expected RPC errors - don't log
                            } else {
                                debugWarn(`Error in ${scanType} scan for ${address}:`, e.message);
                            }
                            // Update scanned count even on error
                            this.updateProgress({ scanned: this.progress.scanned + 1 });
                        }
                        
                        // Small delay between contracts
                        await new Promise(r => setTimeout(r, 300));
                    }
                    
                    // For background scan, yield to main thread more frequently
                    if (isBackground && i % 2 === 0) {
                        await new Promise(r => setTimeout(r, 200));
                    }
                    
                    // Small delay between batches
                    if (i + batchSize < contractsToScan.length) {
                        await new Promise(r => setTimeout(r, isBackground ? 1000 : 400));
                    }
                }
            } finally {
                clearInterval(saveInterval);
                this.saveContractCache();
                this.saveKnownErc20s();
            }
            
            const scanDuration = ((Date.now() - this.scanStartTime) / 1000).toFixed(1);
            this.updateStatus(`✅ ${scanType} scan complete! Found ${allNfts.length} NFTs in ${scanDuration}s`);
            
            // NEW: Final ownership verification to ensure accuracy
            if (allNfts.length > 0) {
                this.updateStatus(`🔒 Performing final ownership verification...`);
                const verifiedNfts = await this.verifyNFTOwnership(allNfts);
                const finalDuration = ((Date.now() - this.scanStartTime) / 1000).toFixed(1);
                this.updateStatus(`✅ Scan complete! ${verifiedNfts.length} verified NFTs in ${finalDuration}s`);
                return verifiedNfts;
            }
            
            return allNfts;
        } catch (error) {
            criticalError("Error in conservative NFT scan:", error);
            this.updateStatus(`❌ Error scanning: ${error.message}`);
            return this.nfts; // Return whatever we found so far
        }
    }
    
    // Scan a single contract with improved error handling and retry mechanisms
    async scanSingleContract(address, scanFromGenesis = false) {
        try {
            // Add retry mechanism for network issues
            const maxRetries = 2;
            let lastError = null;
            
            for (let retry = 0; retry <= maxRetries; retry++) {
                try {
                    // First check if this is an ERC20 token (with improved handling)
                    if (await this.isERC20Token(address)) {
                        this.knownErc20s.add(address.toLowerCase());
                        debugLog(`Skipping ERC20 token: ${address}`);
                        return [];
                    }
                    
                    // Then try to detect if this is an NFT contract (with improved handling)
                    const contractType = await this.detectNFTStandard(address);
                    
                    if (contractType === 'ERC721') {
                        this.updateStatus(`Scanning ERC721 contract: ${address}`);
                        const erc721NFTs = await this.scanERC721Contract(address, scanFromGenesis);
                        return erc721NFTs;
                    } 
                    else if (contractType === 'ERC1155') {
                        this.updateStatus(`Scanning ERC1155 contract: ${address}`);
                        const erc1155NFTs = await this.scanERC1155Contract(address, scanFromGenesis);
                        return erc1155NFTs;
                    }
                    
                    // Not an NFT contract we recognize
                    return [];
                    
                } catch (retryError) {
                    lastError = retryError;
                    
                    // If it's a known recoverable error, retry
                    if (retry < maxRetries && (
                        retryError.message.includes('network error') ||
                        retryError.message.includes('timeout') ||
                        retryError.message.includes('rate limit') ||
                        retryError.code === 'NETWORK_ERROR'
                    )) {
                        debugLog(`Retrying contract ${address} due to network error (attempt ${retry + 1}/${maxRetries + 1})`);
                        await new Promise(r => setTimeout(r, 1000 * (retry + 1))); // Exponential backoff
                        continue;
                    }
                    
                    // If it's an execution revert or other contract error, don't retry
                    if (retryError.message.includes('execution reverted') ||
                        retryError.message.includes('call revert exception')) {
                        debugLog(`Contract ${address} - execution reverted (not an NFT contract)`);
                        return [];
                    }
                    
                    // For other errors, break out of retry loop
                    break;
                }
            }
            
            // If we get here, all retries failed
            throw lastError;
            
        } catch (error) {
            // Improved error logging - only log unique errors to avoid spam
            const errorKey = `${address}-${error.message?.substring(0, 50)}`;
            if (!this.errors[errorKey]) {
                // Only log first few unique errors to avoid console spam
                if (Object.keys(this.errors).length < 10) {
                    debugWarn(`Error scanning contract ${address}:`, error.message);
                }
                this.errors[errorKey] = error.message;
            }
            
            // Update progress even on error
            this.updateProgress({ scanned: this.progress.scanned + 1 });
            return [];
        }
    }

    // Check if a contract is an ERC20 token with comprehensive error handling
    async isERC20Token(contractAddress) {
        // Check cache first
        if (this.knownErc20s.has(contractAddress.toLowerCase())) {
            return true;
        }

        try {
            // Quick check for decimals() function which exists in ERC20 but not in NFTs
            const erc20Contract = new ethers.Contract(contractAddress, ERC20_ABI, this.provider);
            
            try {
                // Add timeout to prevent hanging RPC calls with comprehensive error handling
                const decimalsPromise = erc20Contract.decimals();
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('RPC call timeout')), 5000)
                );
                
                const decimals = await Promise.race([decimalsPromise, timeoutPromise]);
                
                // If we got decimals and it's a reasonable number, this is likely an ERC20 token
                if (decimals !== undefined && decimals >= 0 && decimals <= 50) {
                    this.knownErc20s.add(contractAddress.toLowerCase());
                    return true;
                }
            } catch (e) {
                // Comprehensive error handling to catch all RPC errors
                if (e.message.includes('execution reverted') || 
                    e.message.includes('call revert exception') ||
                    e.message.includes('Internal JSON-RPC error') ||
                    e.message.includes('missing revert data') ||
                    e.code === -32603 || e.code === -32000 || e.code === 'CALL_EXCEPTION') {
                    // This is a normal contract call failure - not an error to log
                    // Just means the contract doesn't have a decimals function
                } else {
                    // Only log unexpected errors
                    debugWarn(`Unexpected error checking decimals for ${contractAddress}:`, e.message);
                }
            }
            
            // Additional check using transfer event pattern analysis
            try {
                // Get recent transfers with shorter block range to avoid RPC limits
                const currentBlock = await this.provider.getBlockNumber();
                const fromBlock = Math.max(0, currentBlock - 5000); // Only last 5k blocks for pattern analysis
                
                const filter = {
                    address: contractAddress,
                    topics: [ethers.id("Transfer(address,address,uint256)")],
                    fromBlock: fromBlock,
                    toBlock: 'latest'
                };
                
                const logsPromise = this.provider.getLogs(filter);
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('getLogs timeout')), 8000)
                );
                
                const logs = await Promise.race([logsPromise, timeoutPromise]);
                
                // Analyze a small sample of transfer events
                const sampleSize = Math.min(logs.length, 5); // Smaller sample size
                
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
                    if (erc20Count > erc721Count && erc20Count > 0) {
                        this.knownErc20s.add(contractAddress.toLowerCase());
                        return true;
                    }
                }
            } catch (e) {
                // Comprehensive error handling for getLogs calls
                if (e.message.includes('execution reverted') || 
                    e.message.includes('call revert exception') ||
                    e.message.includes('Internal JSON-RPC error') ||
                    e.message.includes('missing revert data') ||
                    e.message.includes('timeout') ||
                    e.code === -32603 || e.code === -32000 || e.code === 'CALL_EXCEPTION') {
                    // Expected errors - don't log
                } else {
                    // Only log truly unexpected errors
                    debugWarn(`Unexpected error checking transfers for ${contractAddress}:`, e.message);
                }
            }
            
            return false;
            
        } catch (error) {
            // Comprehensive top-level error handling
            if (error.message.includes('execution reverted') || 
                error.message.includes('call revert exception') ||
                error.message.includes('Internal JSON-RPC error') ||
                error.message.includes('missing revert data') ||
                error.code === -32603 || error.code === -32000 || error.code === 'CALL_EXCEPTION') {
                // These are expected for many contracts - don't log
                return false;
            } else {
                // Only log unexpected errors
                debugWarn(`Unexpected error checking if ${contractAddress} is ERC20:`, error.message);
                return false;
            }
        }
    }

    // Find contracts from recent Transfer events (smart approach based on flag)
    async findContractsByRecentTransfers(scanFromGenesis = false) {
        try {
            const contracts = new Set();
            
            // Smart scanning approach based on flag
            const currentBlock = await this.provider.getBlockNumber();
            // FIXED: Smart selection based on scanFromGenesis flag
            const fromBlock = scanFromGenesis ? 0 : Math.max(0, currentBlock - 200000); // 200k recent blocks for smart scanning (increased for better coverage)
            
            if (scanFromGenesis) {
                debugLog(`🔍 DEBUG: findContractsByRecentTransfers - comprehensive genesis scan from block 0 to ${currentBlock}`);
                this.updateStatus(`🔍 Comprehensive blockchain scan (block 0 to ${currentBlock}) - scanning all history...`);
                debugLog(`🌐 Comprehensive blockchain scan: blocks 0 to ${currentBlock} for complete coverage`);
            } else {
                debugLog(`🔍 DEBUG: findContractsByRecentTransfers - smart scan from block ${fromBlock} to ${currentBlock}`);
                this.updateStatus(`🔍 Smart blockchain scan (block ${fromBlock} to ${currentBlock}) - scanning recent activity...`);
                debugLog(`🌐 Smart blockchain scan: blocks ${fromBlock} to ${currentBlock} for fast performance`);
            }
            
            // Use chunked approach to scan blockchain history
            try {
                await this.findTransfersByChunks(ethers.id("Transfer(address,address,uint256)"), 
                    ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32), 
                    contracts, fromBlock, currentBlock);
                
                // Try ERC1155 TransferSingle events
                await this.findTransfersByChunks(ethers.id("TransferSingle(address,address,address,uint256,uint256)"),
                    ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32),
                    contracts, fromBlock, currentBlock, true);
            } catch (chunkedError) {
                debugWarn("Chunked transfer scanning failed, using fallback approach:", chunkedError);
                // Fall back to the fallback method which respects scanFromGenesis
                throw chunkedError; // Let the caller handle this by calling the fallback method
            }
            
            // Filter out known ERC20s
            const filteredContracts = [...contracts].filter(addr => 
                !this.knownErc20s.has(addr.toLowerCase())
            );
                
            const scanType = scanFromGenesis ? 'comprehensive' : 'smart';
            this.updateStatus(`Found ${filteredContracts.length} potential NFT contracts from ${scanType} scan`);
            return filteredContracts;
        } catch (error) {
            criticalError("Error finding contracts by recent transfers:", error);
            return [];
        }
    }

    // Fallback method for when comprehensive scan fails
    async findContractsByRecentTransfersFallback(scanFromGenesis = false) {
        try {
            const contracts = new Set();
            
            // Smart fallback approach based on flag
            const currentBlock = await this.provider.getBlockNumber();
            // FIXED: Smart selection based on scanFromGenesis flag
            const fromBlock = scanFromGenesis ? 0 : Math.max(0, currentBlock - 300000); // 300k blocks for fallback (increased coverage)
            
            if (scanFromGenesis) {
                debugLog(`🔍 DEBUG: findContractsByRecentTransfersFallback - comprehensive genesis scan from block 0 to ${currentBlock}`);
                this.updateStatus(`🔄 Fallback genesis scan: blocks 0 to ${currentBlock} (using smaller chunks)...`);
                debugLog(`🔄 Fallback genesis scanning: blocks 0 to ${currentBlock} (comprehensive with smaller chunks)`);
            } else {
                debugLog(`🔍 DEBUG: findContractsByRecentTransfersFallback - smart fallback scan from block ${fromBlock} to ${currentBlock}`);
                this.updateStatus(`🔄 Fallback smart scan: blocks ${fromBlock} to ${currentBlock} (using smaller chunks)...`);
                debugLog(`🔄 Fallback smart scanning: blocks ${fromBlock} to ${currentBlock} (smart with smaller chunks)`);
            }
            
            // Scan fallback transfers with error handling
            await this.findTransfersByRecentBlocks(ethers.id("Transfer(address,address,uint256)"), 
                ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32), 
                contracts, fromBlock, currentBlock);
            
            // Try ERC1155 TransferSingle events in fallback blocks
            await this.findTransfersByRecentBlocks(ethers.id("TransferSingle(address,address,address,uint256,uint256)"),
                ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32),
                contracts, fromBlock, currentBlock, true);
            
            // Filter out known ERC20s
            const filteredContracts = [...contracts].filter(addr => 
                !this.knownErc20s.has(addr.toLowerCase())
            );
                
            const scanType = scanFromGenesis ? 'fallback genesis' : 'fallback smart';
            this.updateStatus(`Found ${filteredContracts.length} potential NFT contracts from ${scanType} scan`);
            return filteredContracts;
        } catch (error) {
            criticalError("Error in fallback transfer scanning:", error);
            return [];
        }
    }
    
    // Find transfers by scanning recent blocks only (not entire blockchain)
    async findTransfersByRecentBlocks(eventTopic, walletTopic, contracts, fromBlock, toBlock, isErc1155 = false) {
        try {
            this.updateStatus(`Scanning recent blocks ${fromBlock}-${toBlock} for transfers...`);
            
            const filter = isErc1155 ? {
                topics: [eventTopic, null, null, walletTopic],
                fromBlock: fromBlock,
                toBlock: toBlock
            } : {
                topics: [eventTopic, null, walletTopic],
                fromBlock: fromBlock,
                toBlock: toBlock
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
            
            this.updateStatus(`Found ${contracts.size} potential NFT contracts in recent blocks`);
            
        } catch (error) {
            criticalError("Error in recent transfer search:", error);
        }
    }
    
    // Find transfers by breaking into smaller chunks (smart approach based on flag)
    async findTransfersByChunks(eventTopic, walletTopic, contracts, fromBlock, toBlock, isErc1155 = false) {
        try {
            const currentBlock = toBlock || await this.provider.getBlockNumber();
            const startBlock = fromBlock !== undefined ? fromBlock : 0;
            
            // FIXED: Adaptive chunk size based on scan type
            let chunkSize = fromBlock === 0 ? 25000 : 50000; // Smaller chunks for genesis, larger for recent
            let failedAttempts = 0;
            
            const scanType = fromBlock === 0 ? 'comprehensive' : 'smart';
            debugLog(`🔍 DEBUG: findTransfersByChunks starting ${scanType} scan from block ${startBlock} to ${currentBlock}`);
            
            // Process with adaptive chunk sizing based on scan type
            for (let chunkStart = startBlock; chunkStart < currentBlock; chunkStart += chunkSize) {
                const chunkEnd = Math.min(chunkStart + chunkSize - 1, currentBlock);
                
                try {
                    this.updateStatus(`Scanning blocks ${chunkStart}-${chunkEnd} for transfers (${scanType} scan)...`);
                    
                    const filter = isErc1155 ? {
                        topics: [eventTopic, null, null, walletTopic],
                        fromBlock: chunkStart,
                        toBlock: chunkEnd
                    } : {
                        topics: [eventTopic, null, walletTopic],
                        fromBlock: chunkStart,
                        toBlock: chunkEnd
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
                    
                    this.updateStatus(`Found ${contracts.size} potential NFT contracts in blocks ${chunkStart}-${chunkEnd}`);
                    
                    // If we succeeded, reset failure counter
                    failedAttempts = 0;
                } catch (error) {
                    failedAttempts++;
                    
                    // Conservative error handling for getLogs calls
                    if (error.message.includes('execution reverted') || 
                        error.message.includes('call revert exception') ||
                        error.message.includes('Internal JSON-RPC error') ||
                        error.message.includes('missing revert data') ||
                        error.code === -32603 || error.code === -32000 || error.code === 'CALL_EXCEPTION') {
                        // Expected RPC errors - don't log as warnings, just debug info
                        debugLog(`RPC error scanning blocks ${chunkStart}-${chunkEnd}, continuing...`);
                    } else {
                        // Log unexpected errors
                        debugWarn(`Unexpected error scanning blocks ${chunkStart}-${chunkEnd}:`, error.message);
                    }
                    
                    // If multiple consecutive failures, reduce chunk size or skip ahead
                    if (failedAttempts >= 2) {
                        debugLog(`Multiple RPC failures, reducing scan scope`);
                        // Reduce chunk size significantly
                        if (chunkSize > 5000) {
                            const newChunkSize = Math.floor(chunkSize / 3);
                            debugLog(`Reducing chunk size to ${newChunkSize} blocks due to RPC issues`);
                            chunkSize = newChunkSize;
                            chunkStart -= chunkSize; // Try this range again with smaller size
                        } else {
                            // Skip ahead if chunks are already small
                            debugLog(`Skipping problematic block range ${chunkStart}-${chunkEnd}`);
                        }
                        failedAttempts = 0;
                    }
                }
                
                // Adaptive delay between chunks based on scan type
                const delay = fromBlock === 0 ? 300 : 150; // Longer delay for comprehensive scans
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            
        } catch (error) {
            criticalError("Error in chunked transfer search:", error);
        }
    }

    // Improved detection of NFT standards with comprehensive error handling
    async detectNFTStandard(contractAddress) {
        // Check cache first
        if (this.contractCache[contractAddress] && this.contractCache[contractAddress].type) {
            return this.contractCache[contractAddress].type;
        }
        
        try {
            // Try as ERC721 first with timeout protection and comprehensive error handling
            const erc721Contract = new ethers.Contract(contractAddress, EXTENDED_ERC721_ABI, this.provider);
            
            try {
                // Add timeout to prevent hanging calls with comprehensive error handling
                const balancePromise = erc721Contract.balanceOf(this.walletAddress);
                const timeoutPromise = new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Balance call timeout')), 8000)
                );
                
                const balance = await Promise.race([balancePromise, timeoutPromise]);
                
                if (balance !== undefined) {
                    this.contractCache[contractAddress] = { 
                        type: 'ERC721',
                        balance: Number(balance)
                    };
                    return 'ERC721';
                }
            } catch (e) {
                // Comprehensive error handling for balanceOf calls
                if (e.message.includes('execution reverted') || 
                    e.message.includes('call revert exception') ||
                    e.message.includes('Internal JSON-RPC error') ||
                    e.message.includes('missing revert data') ||
                    e.code === -32603 || e.code === -32000 || e.code === 'CALL_EXCEPTION') {
                    // Expected error - try interface check before giving up
                } else {
                    debugWarn(`Unexpected balanceOf error for ${contractAddress}:`, e.message);
                }
                
                // balanceOf failed, try interface check before giving up on ERC721
                try {
                    const interfacePromise = erc721Contract.supportsInterface("0x80ac58cd");
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Interface check timeout')), 5000)
                    );
                    
                    const supportsERC721 = await Promise.race([interfacePromise, timeoutPromise]);
                    if (supportsERC721) {
                        this.contractCache[contractAddress] = { type: 'ERC721', balance: 0 };
                        return 'ERC721';
                    }
                } catch (interfaceError) {
                    // Comprehensive error handling for interface checks
                    if (interfaceError.message.includes('execution reverted') || 
                        interfaceError.message.includes('call revert exception') ||
                        interfaceError.message.includes('Internal JSON-RPC error') ||
                        interfaceError.message.includes('missing revert data') ||
                        interfaceError.code === -32603 || interfaceError.code === -32000 || interfaceError.code === 'CALL_EXCEPTION') {
                        // Expected error - move on to ERC1155
                    } else {
                        debugWarn(`Unexpected interface error for ${contractAddress}:`, interfaceError.message);
                    }
                }
            }
            
            // Try as ERC1155 with timeout protection and comprehensive error handling
            const erc1155Contract = new ethers.Contract(contractAddress, EXTENDED_ERC1155_ABI, this.provider);
            
            try {
                // Try some common token IDs to see if we own any, with timeout and error handling
                const testTokenIds = [1, 2, 3, 4, 5]; // Reduced test set
                let hasTokens = false;
                
                // Check each token ID individually with timeout and comprehensive error handling
                for (const id of testTokenIds) {
                    try {
                        const balancePromise = erc1155Contract.balanceOf(this.walletAddress, id);
                        const timeoutPromise = new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('ERC1155 balance timeout')), 5000)
                        );
                        
                        const balance = await Promise.race([balancePromise, timeoutPromise]);
                        if (balance > 0) {
                            hasTokens = true;
                            break;
                        }
                    } catch (e) {
                        // Comprehensive error handling for individual token balance checks
                        if (e.message.includes('execution reverted') || 
                            e.message.includes('call revert exception') ||
                            e.message.includes('Internal JSON-RPC error') ||
                            e.message.includes('missing revert data') ||
                            e.code === -32603 || e.code === -32000 || e.code === 'CALL_EXCEPTION') {
                            // Expected error - skip this token ID
                            continue;
                        } else {
                            debugWarn(`Unexpected ERC1155 balance error for ${contractAddress} token ${id}:`, e.message);
                            continue;
                        }
                    }
                }
                
                if (hasTokens) {
                    this.contractCache[contractAddress] = { type: 'ERC1155' };
                    return 'ERC1155';
                }
                
                // Try interface check as last resort with comprehensive error handling
                try {
                    const interfacePromise = erc1155Contract.supportsInterface("0xd9b67a26");
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('ERC1155 interface timeout')), 5000)
                    );
                    
                    const supportsERC1155 = await Promise.race([interfacePromise, timeoutPromise]);
                    if (supportsERC1155) {
                        this.contractCache[contractAddress] = { type: 'ERC1155' };
                        return 'ERC1155';
                    }
                } catch (e) {
                    // Comprehensive error handling for ERC1155 interface checks
                    if (e.message.includes('execution reverted') || 
                        e.message.includes('call revert exception') ||
                        e.message.includes('Internal JSON-RPC error') ||
                        e.message.includes('missing revert data') ||
                        e.code === -32603 || e.code === -32000 || e.code === 'CALL_EXCEPTION') {
                        // Expected error - not an ERC1155
                    } else {
                        debugWarn(`Unexpected ERC1155 interface error for ${contractAddress}:`, e.message);
                    }
                }
            } catch (e) {
                // Comprehensive error handling for ERC1155 checks
                if (e.message.includes('execution reverted') || 
                    e.message.includes('call revert exception') ||
                    e.message.includes('Internal JSON-RPC error') ||
                    e.message.includes('missing revert data') ||
                    e.code === -32603 || e.code === -32000 || e.code === 'CALL_EXCEPTION') {
                    // Expected error - not an ERC1155
                } else {
                    debugWarn(`Unexpected ERC1155 error for ${contractAddress}:`, e.message);
                }
            }
            
            return null; // Not a recognized NFT contract
        } catch (error) {
            // Comprehensive top-level error handling
            if (error.message.includes('execution reverted') || 
                error.message.includes('call revert exception') ||
                error.message.includes('Internal JSON-RPC error') ||
                error.message.includes('missing revert data') ||
                error.message.includes('timeout') ||
                error.code === -32603 || error.code === -32000 || error.code === 'CALL_EXCEPTION') {
                // Expected errors - don't log
                return null;
            } else {
                // Only log unexpected errors
                debugWarn(`Unexpected error detecting NFT standard for ${contractAddress}:`, error.message);
                return null;
            }
        }
    }

    // Scan an ERC721 contract
    async scanERC721Contract(contractAddress, scanFromGenesis = false) {
        try {
            const contract = new ethers.Contract(contractAddress, EXTENDED_ERC721_ABI, this.provider);
            let balance;
            
            try {
                balance = await contract.balanceOf(this.walletAddress);
                balance = Number(balance);
            } catch (e) {
                debugWarn(`Error getting ERC721 balance for ${contractAddress}:`, e);
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
                            debugWarn(`Error with tokenOfOwnerByIndex for ${contractAddress} at index ${i}:`, e);
                        }
                        
                        // If we're getting too many enumeration errors, break out and try event approach
                        if (enumerationErrors > Math.min(5, balance / 2)) {
                            debugWarn(`Too many enumeration errors (${enumerationErrors}), switching to event-based scanning`);
                            break;
                        }
                    }
                }
                
                // If we found some tokens but not the full balance, try event-based approach for the rest
                if (results.length > 0 && results.length < balance) {
                    const eventNFTs = await this.scanERC721ByEvents(contractAddress, contract, contractInfo, results, scanFromGenesis);
                    results.push(...eventNFTs);
                }
                
                // If we found all tokens via enumeration, we're done
                if (results.length === balance) {
                    return results;
                }
            } catch (e) {
                // Contract doesn't support enumeration or has issues, try event-based approach
                debugWarn(`Enumeration failed for ${contractAddress}, using events instead:`, e);
            }
            
            // If we get here, either enumeration failed completely or found only some tokens
            // Try event-based approach as fallback
            if (results.length < balance) {
                const eventResults = await this.scanERC721ByEvents(contractAddress, contract, contractInfo, results, scanFromGenesis);
                results.push(...eventResults);
            }
            
            // If we still found nothing, try a sequential scan for common token IDs
            if (results.length === 0) {
                const sequentialResults = await this.scanERC721SequentialIds(contractAddress, contract, contractInfo);
                results.push(...sequentialResults);
            }
            
            return results;
        } catch (error) {
            criticalError(`Error in ERC721 scan for ${contractAddress}:`, error);
            return [];
        }
    }
    
    // Scan ERC721 using Transfer events with COMPREHENSIVE approach (scan from beginning)
    async scanERC721ByEvents(contractAddress, contract, contractInfo, existingResults = [], scanFromGenesis = false) {
        const results = [];
        
        try {
            // Track token IDs we've already found via enumeration to avoid duplicates
            const foundTokenIds = new Set(existingResults.map(nft => nft.tokenId));
            
            // Get Transfer events TO this wallet - COMPREHENSIVE COVERAGE (scan from beginning)
            const transferTopic = ethers.id('Transfer(address,address,uint256)');
            const toWalletTopic = ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32);
            
            // COMPREHENSIVE approach: Scan from the beginning of blockchain for complete coverage
            try {
                const currentBlock = await this.provider.getBlockNumber();
                const comprehensiveStartBlock = scanFromGenesis ? 0 : Math.max(0, currentBlock - 250000); // Increased to 250k blocks for better coverage
                
                if (scanFromGenesis) {
                    this.updateStatus(`Comprehensive ERC721 scan: blocks 0-${currentBlock} for complete coverage...`);
                    debugLog(`🌐 COMPREHENSIVE ERC721 scan: 0-${currentBlock} blocks for maximum coverage`);
                } else {
                    this.updateStatus(`Conservative ERC721 scan: blocks ${comprehensiveStartBlock}-${currentBlock} for recent coverage...`);
                    debugLog(`🌐 CONSERVATIVE ERC721 scan: ${comprehensiveStartBlock}-${currentBlock} blocks for recent coverage`);
                }
                
                // Use chunked approach for comprehensive scanning to avoid RPC limits
                const tokenIds = new Set();
                await this.scanERC721TransfersInChunks(contractAddress, transferTopic, toWalletTopic, 
                    tokenIds, comprehensiveStartBlock, currentBlock);
                
                this.updateStatus(`Found ${tokenIds.size} potential token IDs from comprehensive event scan`);
                
                // Check each token ID to see if we still own it (with timeouts and comprehensive error handling)
                for (const tokenId of tokenIds) {
                    // Skip tokens we already found via enumeration
                    if (foundTokenIds.has(tokenId)) continue;
                    
                    try {
                        // Add timeout to prevent hanging RPC calls with comprehensive error handling
                        const ownerPromise = contract.ownerOf(tokenId);
                        const timeoutPromise = new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('ownerOf timeout')), 6000)
                        );
                        
                        const owner = await Promise.race([ownerPromise, timeoutPromise]);
                        if (owner.toLowerCase() === this.walletAddress.toLowerCase()) {
                            // We own this token
                            let tokenURI = null;
                            try {
                                const uriPromise = contract.tokenURI(tokenId);
                                const uriTimeoutPromise = new Promise((_, reject) => 
                                    setTimeout(() => reject(new Error('tokenURI timeout')), 5000)
                                );
                                
                                tokenURI = await Promise.race([uriPromise, uriTimeoutPromise]);
                            } catch (e) {
                                // URI might not be available - don't log errors for this
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
                        // Comprehensive error handling for ownership checks
                        if (e.message.includes('execution reverted') || 
                            e.message.includes('call revert exception') ||
                            e.message.includes('Internal JSON-RPC error') ||
                            e.message.includes('missing revert data') ||
                            e.message.includes('timeout') ||
                            e.code === -32603 || e.code === -32000 || e.code === 'CALL_EXCEPTION') {
                            // Expected errors - token doesn't exist or we don't own it
                        } else {
                            debugWarn(`Unexpected error checking ownership of token ${tokenId}:`, e.message);
                        }
                    }
                }
            } catch (logError) {
                criticalError(`Error scanning comprehensive transfer events for ${contractAddress}:`, logError);
                
                // Fallback to recent blocks if comprehensive scan fails
                debugLog("Falling back to recent block scanning for ERC721 transfers...");
                return await this.scanERC721ByEventsFallback(contractAddress, contract, contractInfo, existingResults, scanFromGenesis);
            }
        } catch (error) {
            criticalError(`Error in comprehensive event-based scan for ${contractAddress}:`, error);
        }
        
        return results;
    }

    // Fallback ERC721 event scanning - respects scanFromGenesis flag
    async scanERC721ByEventsFallback(contractAddress, contract, contractInfo, existingResults = [], scanFromGenesis = false) {
        const results = [];
        
        try {
            // Track token IDs we've already found via enumeration to avoid duplicates
            const foundTokenIds = new Set(existingResults.map(nft => nft.tokenId));
            
            // Get Transfer events TO this wallet - respecting genesis flag even in fallback
            const transferTopic = ethers.id('Transfer(address,address,uint256)');
            const toWalletTopic = ethers.zeroPadValue(this.walletAddress.toLowerCase(), 32);
            
            // Respect scanFromGenesis flag even in fallback
            const currentBlock = await this.provider.getBlockNumber();
            const fallbackStartBlock = scanFromGenesis ? 0 : Math.max(0, currentBlock - 500000);
            
            if (scanFromGenesis) {
                this.updateStatus(`Fallback ERC721 genesis scan: blocks 0-${currentBlock} (using smaller chunks)...`);
                debugLog(`🔄 Fallback ERC721 genesis scan: 0-${currentBlock} blocks (comprehensive with smaller chunks)`);
            } else {
                this.updateStatus(`Fallback ERC721 scan: blocks ${fallbackStartBlock}-${currentBlock}...`);
                debugLog(`🔄 Fallback ERC721 scan: ${fallbackStartBlock}-${currentBlock} blocks`);
            }
            
            const filter = {
                address: contractAddress,
                topics: [transferTopic, null, toWalletTopic],
                fromBlock: fallbackStartBlock,
                toBlock: 'latest'
            };
            
            const logs = await this.provider.getLogs(filter);
            
            // Extract unique token IDs from fallback transfers - WITH SAFETY CHECKS
            const tokenIds = new Set();
            for (const log of logs) {
                if (log.topics.length === 4 && log.topics[3] !== null) {
                    try {
                        // This looks like an NFT transfer (has indexed tokenId)
                        const tokenId = ethers.toBigInt(log.topics[3]);
                        tokenIds.add(tokenId.toString());
                    } catch (e) {
                        debugWarn(`Error extracting token ID from log:`, e);
                    }
                }
            }
            
            this.updateStatus(`Found ${tokenIds.size} potential token IDs from fallback event scan`);
            
            // Check each token ID to see if we still own it (with timeouts)
            for (const tokenId of tokenIds) {
                // Skip tokens we already found via enumeration
                if (foundTokenIds.has(tokenId)) continue;
                
                try {
                    // Add timeout to prevent hanging RPC calls
                    const ownerPromise = contract.ownerOf(tokenId);
                    const timeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('ownerOf timeout')), 6000)
                    );
                    
                    const owner = await Promise.race([ownerPromise, timeoutPromise]);
                    if (owner.toLowerCase() === this.walletAddress.toLowerCase()) {
                        // We own this token
                        let tokenURI = null;
                        try {
                            const uriPromise = contract.tokenURI(tokenId);
                            const uriTimeoutPromise = new Promise((_, reject) => 
                                setTimeout(() => reject(new Error('tokenURI timeout')), 5000)
                            );
                            
                            tokenURI = await Promise.race([uriPromise, uriTimeoutPromise]);
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
                    // Only log unexpected errors
                    if (!e.message.includes('timeout') && !e.message.includes('execution reverted')) {
                        debugWarn(`Error checking ownership of token ${tokenId}:`, e.message);
                    }
                }
            }
        } catch (error) {
            criticalError(`Error in fallback event-based scan for ${contractAddress}:`, error);
        }
        
        return results;
    }

    // Helper method to scan ERC721 transfers in chunks to handle comprehensive scanning
    async scanERC721TransfersInChunks(contractAddress, transferTopic, toWalletTopic, tokenIds, fromBlock, toBlock) {
        const chunkSize = 100000; // 100k blocks per chunk
        
        for (let startBlock = fromBlock; startBlock < toBlock; startBlock += chunkSize) {
            const endBlock = Math.min(startBlock + chunkSize - 1, toBlock);
            
            try {
                this.updateStatus(`Scanning ERC721 transfers in blocks ${startBlock}-${endBlock}...`);
                
                const filter = {
                    address: contractAddress,
                    topics: [transferTopic, null, toWalletTopic],
                    fromBlock: startBlock,
                    toBlock: endBlock
                };
                
                const logs = await this.provider.getLogs(filter);
                
                // Extract unique token IDs from transfers
                for (const log of logs) {
                    if (log.topics.length === 4 && log.topics[3] !== null) {
                        try {
                            // This looks like an NFT transfer (has indexed tokenId)
                            const tokenId = ethers.toBigInt(log.topics[3]);
                            tokenIds.add(tokenId.toString());
                        } catch (e) {
                            // Skip invalid token IDs
                        }
                    }
                }
            } catch (e) {
                // Comprehensive error handling for chunked scanning
                if (e.message.includes('execution reverted') || 
                    e.message.includes('call revert exception') ||
                    e.message.includes('Internal JSON-RPC error') ||
                    e.message.includes('missing revert data') ||
                    e.code === -32603 || e.code === -32000 || e.code === 'CALL_EXCEPTION') {
                    // Expected RPC errors - skip this chunk
                    debugLog(`RPC error scanning ERC721 transfers in blocks ${startBlock}-${endBlock}, skipping...`);
                } else {
                    debugWarn(`Unexpected error scanning ERC721 transfers in blocks ${startBlock}-${endBlock}:`, e.message);
                }
            }
        }
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
            criticalError(`Error in sequential ID scan for ${contractAddress}:`, error);
        }
        
        return results;
    }

    // Scan an ERC1155 contract
    async scanERC1155Contract(contractAddress, scanFromGenesis = false) {
        try {
            const contract = new ethers.Contract(contractAddress, EXTENDED_ERC1155_ABI, this.provider);
            const contractInfo = await this.getContractInfo(contractAddress, 'ERC1155');
            
            this.updateStatus(`Scanning ${contractInfo.name || contractAddress} (ERC1155)...`);
            
            // Find ALL token IDs for this contract
            const tokenIds = await this.discoverERC1155TokenIds(contract, contractAddress, scanFromGenesis);
            
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
                    debugWarn(`Batch balance check failed for ${contractInfo.name}, trying individual calls`);
                    
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
            criticalError(`Error in ERC1155 scan for ${contractAddress}:`, error);
            return [];
        }
    }

    // Discover ERC1155 token IDs using COMPREHENSIVE approach (scan from beginning)
    async discoverERC1155TokenIds(contract, contractAddress, scanFromGenesis = false) {
        try {
            const tokenIds = new Set();
            
            // Choose approach based on scanFromGenesis flag
            const currentBlock = await this.provider.getBlockNumber();
            const fromBlock = scanFromGenesis ? 0 : Math.max(0, currentBlock - 100000);
            const toBlock = 'latest';
            
            if (scanFromGenesis) {
                this.updateStatus(`Comprehensive ERC1155 scan: blocks 0-${toBlock} for complete coverage...`);
                debugLog(`🌐 COMPREHENSIVE ERC1155 discovery: 0-${toBlock} blocks for maximum coverage`);
            } else {
                this.updateStatus(`Conservative ERC1155 scan: blocks ${fromBlock}-${toBlock} for recent coverage...`);
                debugLog(`🌐 CONSERVATIVE ERC1155 discovery: ${fromBlock}-${toBlock} blocks for recent coverage`);
            }
            
            try {
                // Try comprehensive scanning with chunked approach to avoid RPC limits
                await this.discoverERC1155TokenIdsInChunks(contract, contractAddress, tokenIds, fromBlock, currentBlock);
                
                this.updateStatus(`Found ${tokenIds.size} total token IDs including batch events`);
                
            } catch (error) {
                debugWarn(`Error getting comprehensive events for ${contractAddress}, using fallback discovery:`, error.message);
                
                // Enhanced fallback: More comprehensive than conservative approach
                this.updateStatus("Using enhanced fallback token ID discovery...");
                
                // Check more sequential IDs than conservative approach
                for (let i = 0; i <= 200; i++) {
                    tokenIds.add(i.toString());
                }
                
                // Add more powers of 10 and 2
                for (let i = 0; i <= 6; i++) {
                    tokenIds.add(Math.pow(10, i).toString());
                }
                
                for (let i = 0; i <= 20; i++) {
                    tokenIds.add(Math.pow(2, i).toString());
                }
            }
            
            // If the set is still empty, add common token IDs
            if (tokenIds.size === 0) {
                for (let i = 0; i <= 50; i++) {
                    tokenIds.add(i.toString());
                }
            }
            
            debugLog(`🌐 COMPREHENSIVE ERC1155 discovery: ${tokenIds.size} token IDs to check (maximum coverage)`);
            return [...tokenIds];
        } catch (error) {
            criticalError(`Error discovering ERC1155 token IDs for ${contractAddress}:`, error);
            
            // Return enhanced common token IDs as fallback
            const enhancedIds = [];
            for (let i = 0; i <= 50; i++) enhancedIds.push(i.toString());
            return enhancedIds;
        }
    }

    // Helper method to discover ERC1155 token IDs in chunks for comprehensive scanning
    async discoverERC1155TokenIdsInChunks(contract, contractAddress, tokenIds, fromBlock, toBlock) {
        const chunkSize = 100000; // 100k blocks per chunk
        
        for (let startBlock = fromBlock; startBlock < toBlock; startBlock += chunkSize) {
            const endBlock = Math.min(startBlock + chunkSize - 1, toBlock);
            
            try {
                this.updateStatus(`Scanning ERC1155 events in blocks ${startBlock}-${endBlock}...`);
                
                // Try TransferSingle events with comprehensive error handling
                try {
                    const singleFilterPromise = contract.queryFilter(
                        contract.filters.TransferSingle(null, null, this.walletAddress),
                        startBlock, 
                        endBlock
                    );
                    const singleTimeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('TransferSingle query timeout')), 15000)
                    );
                    
                    const singleEvents = await Promise.race([singleFilterPromise, singleTimeoutPromise]);
                    
                    singleEvents.forEach(event => {
                        tokenIds.add(event.args.id.toString());
                    });
                } catch (singleError) {
                    // Comprehensive error handling
                    if (singleError.message.includes('execution reverted') || 
                        singleError.message.includes('call revert exception') ||
                        singleError.message.includes('Internal JSON-RPC error') ||
                        singleError.message.includes('missing revert data') ||
                        singleError.code === -32603 || singleError.code === -32000 || singleError.code === 'CALL_EXCEPTION') {
                        // Expected RPC errors - skip this chunk
                        debugLog(`RPC error getting TransferSingle events in blocks ${startBlock}-${endBlock}, skipping...`);
                    } else {
                        debugWarn(`Unexpected error getting TransferSingle events in blocks ${startBlock}-${endBlock}:`, singleError.message);
                    }
                }
                
                // Try TransferBatch events with comprehensive error handling
                try {
                    const batchFilterPromise = contract.queryFilter(
                        contract.filters.TransferBatch(null, null, this.walletAddress),
                        startBlock, 
                        endBlock
                    );
                    const batchTimeoutPromise = new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('TransferBatch query timeout')), 15000)
                    );
                    
                    const batchEvents = await Promise.race([batchFilterPromise, batchTimeoutPromise]);
                    
                    batchEvents.forEach(event => {
                        event.args.ids.forEach(id => tokenIds.add(id.toString()));
                    });
                } catch (batchError) {
                    // Comprehensive error handling
                    if (batchError.message.includes('execution reverted') || 
                        batchError.message.includes('call revert exception') ||
                        batchError.message.includes('Internal JSON-RPC error') ||
                        batchError.message.includes('missing revert data') ||
                        batchError.code === -32603 || batchError.code === -32000 || batchError.code === 'CALL_EXCEPTION') {
                        // Expected RPC errors - skip this chunk
                        debugLog(`RPC error getting TransferBatch events in blocks ${startBlock}-${endBlock}, skipping...`);
                    } else {
                        debugWarn(`Unexpected error getting TransferBatch events in blocks ${startBlock}-${endBlock}:`, batchError.message);
                    }
                }
                
            } catch (chunkError) {
                // Comprehensive error handling for entire chunk
                if (chunkError.message.includes('execution reverted') || 
                    chunkError.message.includes('call revert exception') ||
                    chunkError.message.includes('Internal JSON-RPC error') ||
                    chunkError.message.includes('missing revert data') ||
                    chunkError.code === -32603 || chunkError.code === -32000 || chunkError.code === 'CALL_EXCEPTION') {
                    // Expected RPC errors - skip this chunk
                    debugLog(`RPC error scanning ERC1155 events in blocks ${startBlock}-${endBlock}, skipping...`);
                } else {
                    debugWarn(`Unexpected error scanning ERC1155 events in blocks ${startBlock}-${endBlock}:`, chunkError.message);
                }
            }
        }
    }
    
    // Find ERC1155 token IDs by chunking
    async findERC1155TokenIdsByChunks(contract, contractAddress, tokenIds) {
        try {
            const currentBlock = await this.provider.getBlockNumber();
            const chunkSize = 100000; // 100k blocks at a time
            
            // Process in chunks from the beginning of blockchain history for complete NFT discovery
            for (let startBlock = 0; startBlock < currentBlock; startBlock += chunkSize) {
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
                        debugWarn(`Error getting TransferSingle events in blocks ${startBlock}-${endBlock}:`, e);
                    }
                    
                    // TransferBatch events
                    try {
                        const batchFilter = contract.filters.TransferBatch(null, null, this.walletAddress);
                        const batchEvents = await contract.queryFilter(batchFilter, startBlock, endBlock);
                        
                        batchEvents.forEach(event => {
                            event.args.ids.forEach(id => tokenIds.add(id.toString()));
                        });
                    } catch (e) {
                        debugWarn(`Error getting TransferBatch events in blocks ${startBlock}-${endBlock}:`, e);
                    }
                } catch (error) {
                    debugWarn(`Error scanning blocks ${startBlock}-${endBlock} for ERC1155 tokens:`, error);
                }
            }
        } catch (error) {
            criticalError(`Error in chunked ERC1155 token ID discovery:`, error);
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
            debugWarn(`Error getting contract info for ${contractAddress}:`, error);
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
            debugWarn(`Error fetching metadata for ${contractAddress} token ${tokenId}:`, error);
            
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
        
        debugLog(`Lazy loading metadata for ${nftsToFetch.length} NFTs`);
        
        // Process in smaller batches to avoid overwhelming network
        for (let i = 0; i < nftsToFetch.length; i += batchSize) {
            const batch = nftsToFetch.slice(i, i + batchSize);
            
            // Process batch in parallel
            await Promise.all(
                batch.map(nft => 
                    this.getMetadata(nft.contractAddress, nft.tokenId, nft.tokenURI)
                        .catch(err => debugWarn(`Error loading metadata for token ${nft.tokenId}:`, err))
                )
            );
            
            // Small delay between batches
            if (i + batchSize < nftsToFetch.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
        
        debugLog(`Completed loading metadata for ${nftsToFetch.length} NFTs`);
    }

    // Add this static method to your NFTScanner class for user guidance
    static getDisclaimer() {
        return {
            title: "Enhanced NFT Scanning Process",
            message: "Searching for your NFTs across the blockchain using a balanced approach. This ensures we find your NFTs while maintaining reasonable performance.",
            tips: [
                "We scan the last 6 months of blockchain history for comprehensive coverage",
                "Recently acquired NFTs will appear first",
                "Cached results load instantly on future visits",
                "If scanning fails, try the 'Force Refresh' button",
                "Network errors are automatically retried"
            ]
        };
    }
}