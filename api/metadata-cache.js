/**
 * Metadata Cache API - Serves normalized NFT metadata with instant cache-first approach
 * 
 * Features:
 * - Cache-first metadata serving
 * - Automatic TTL management
 * - Pre-warming support
 * - Metrics tracking
 * - Fallback to live IPFS fetch
 * 
 * Usage: /api/metadata-cache?contract=0x123&tokenId=456
 */

const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

// Cache configuration
const CACHE_CONFIG = {
    METADATA_TTL: 6 * 60 * 60 * 1000, // 6 hours for metadata
    FALLBACK_TTL: 60 * 60 * 1000,     // 1 hour for failed fetches
    DEFAULT_PLACEHOLDER: 'https://via.placeholder.com/300x300/1a1a1a/fff?text=NFT'
};

// IPFS gateways for metadata fetching
const IPFS_GATEWAYS = [
    'https://ipfs.io/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/'
];

// Standard NFT ABIs
const ERC721_ABI = [
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function name() view returns (string)',
    'function symbol() view returns (string)'
];

const ERC1155_ABI = [
    'function uri(uint256 tokenId) view returns (string)',
    'function name() view returns (string)',
    'function symbol() view returns (string)'
];

// Initialize Supabase client
let supabase = null;
function initSupabase() {
    if (!supabase) {
        const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
        const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
        
        if (supabaseUrl && supabaseKey && supabaseUrl !== 'https://dummy.supabase.co') {
            supabase = createClient(supabaseUrl, supabaseKey);
        }
    }
    return supabase;
}

/**
 * Main handler for metadata cache requests
 */
module.exports = async (req, res) => {
    // Only handle GET requests
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { contract, tokenId, refresh } = req.query;
    
    if (!contract || !tokenId) {
        return res.status(400).json({ 
            error: 'Missing required parameters: contract and tokenId' 
        });
    }

    try {
        const startTime = Date.now();
        const cacheKey = `${contract.toLowerCase()}-${tokenId}`;
        
        // Check cache first (unless refresh is requested)
        if (refresh !== 'true') {
            const cached = await getCachedMetadata(cacheKey);
            if (cached && !isExpired(cached.ttl_expires_at)) {
                await recordCacheHit('metadata_hit');
                await updateCacheHits(cached.id);
                
                const latency = Date.now() - startTime;
                await recordLatency('metadata', latency);
                
                // Set cache headers
                res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
                res.setHeader('X-Cache-Status', 'HIT');
                
                return res.json({
                    ...cached.metadata,
                    cached: true,
                    latency,
                    cacheKey
                });
            }
        }

        // Cache miss - fetch metadata from contract
        await recordCacheHit('metadata_miss');
        
        const metadata = await fetchMetadataFromContract(contract, tokenId);
        if (!metadata.success) {
            await recordCacheHit('metadata_error');
            return res.status(404).json({ 
                error: 'Metadata not found',
                contract,
                tokenId,
                details: metadata.error
            });
        }

        // Process and normalize the metadata
        const normalizedMetadata = normalizeMetadata(metadata.data, contract, tokenId);
        
        // Cache the result
        await cacheMetadata({
            contractAddress: contract,
            tokenId,
            cacheKey,
            metadata: normalizedMetadata,
            tokenUri: metadata.tokenUri
        });

        const latency = Date.now() - startTime;
        await recordLatency('metadata', latency);

        // Set cache headers
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
        res.setHeader('X-Cache-Status', 'MISS');

        return res.json({
            ...normalizedMetadata,
            cached: false,
            latency,
            cacheKey
        });

    } catch (error) {
        console.error('Metadata cache error:', error);
        await recordCacheHit('metadata_error');
        
        return res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
};

/**
 * Fetch metadata from contract with fallback to IPFS
 */
async function fetchMetadataFromContract(contractAddress, tokenId) {
    try {
        // Initialize provider
        const rpcUrl = process.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
        const provider = new ethers.JsonRpcProvider(rpcUrl);
        
        // Try ERC721 first
        let tokenURI;
        try {
            const contract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
            tokenURI = await Promise.race([
                contract.tokenURI(tokenId),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('tokenURI timeout')), 8000))
            ]);
        } catch {
            // Fallback to ERC1155
            try {
                const contract = new ethers.Contract(contractAddress, ERC1155_ABI, provider);
                tokenURI = await Promise.race([
                    contract.uri(tokenId),
                    new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('uri timeout')), 8000))
                ]);
            } catch (e) {
                return { 
                    success: false, 
                    error: `No URI method available: ${e.message}` 
                };
            }
        }

        if (!tokenURI || tokenURI === '') {
            return { 
                success: false, 
                error: 'Empty tokenURI returned' 
            };
        }

        // Fetch metadata from the URI
        const metadata = await fetchMetadataFromURI(tokenURI);
        
        return {
            success: true,
            data: metadata,
            tokenUri: tokenURI
        };

    } catch (error) {
        return { 
            success: false, 
            error: error.message 
        };
    }
}

/**
 * Fetch metadata from URI with multi-gateway support
 */
async function fetchMetadataFromURI(tokenURI) {
    // Handle data URIs
    if (tokenURI.startsWith('data:')) {
        try {
            const jsonString = tokenURI.split(',')[1];
            const decodedData = atob(jsonString);
            return JSON.parse(decodedData);
        } catch (error) {
            throw new Error(`Invalid data URI: ${error.message}`);
        }
    }

    // Handle HTTP URLs
    if (tokenURI.startsWith('http://') || tokenURI.startsWith('https://')) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        
        try {
            const response = await fetch(tokenURI, {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            
            return await response.json();
        } catch (error) {
            clearTimeout(timeoutId);
            throw error;
        }
    }

    // Handle IPFS URLs with gateway fallback
    if (tokenURI.startsWith('ipfs://') || tokenURI.includes('/ipfs/')) {
        const hash = tokenURI.startsWith('ipfs://') 
            ? tokenURI.replace('ipfs://', '') 
            : tokenURI.split('/ipfs/')[1];

        // Try multiple gateways
        for (const gateway of IPFS_GATEWAYS) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000);
                
                const response = await fetch(`${gateway}${hash}`, {
                    method: 'GET',
                    headers: { 'Accept': 'application/json' },
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                if (response.ok) {
                    return await response.json();
                }
            } catch {
                continue; // Try next gateway
            }
        }
        
        throw new Error('All IPFS gateways failed');
    }

    throw new Error(`Unsupported URI format: ${tokenURI}`);
}

/**
 * Normalize metadata to consistent format
 */
function normalizeMetadata(metadata, contractAddress, tokenId) {
    return {
        name: metadata?.name || `NFT #${tokenId}`,
        description: metadata?.description || '',
        image: metadata?.image || metadata?.imageUrl || CACHE_CONFIG.DEFAULT_PLACEHOLDER,
        imageUrl: metadata?.image || metadata?.imageUrl || CACHE_CONFIG.DEFAULT_PLACEHOLDER,
        attributes: metadata?.attributes || metadata?.traits || [],
        contractAddress: contractAddress.toLowerCase(),
        tokenId: tokenId.toString(),
        collection: metadata?.collection || null,
        externalUrl: metadata?.external_url || metadata?.externalUrl || null,
        animationUrl: metadata?.animation_url || metadata?.animationUrl || null,
        backgroundColor: metadata?.background_color || metadata?.backgroundColor || null,
        loaded: true,
        loading: false,
        error: null,
        timestamp: Date.now(),
        loadingStrategy: 'cache_api'
    };
}

/**
 * Get cached metadata from database
 */
async function getCachedMetadata(cacheKey) {
    const client = initSupabase();
    if (!client) return null;

    try {
        const { data, error } = await client
            .from('metadata_cache')
            .select('*')
            .eq('cache_key', cacheKey)
            .single();

        if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
            console.error('Metadata cache lookup error:', error);
            return null;
        }

        return data;
    } catch (error) {
        console.error('Metadata cache lookup error:', error);
        return null;
    }
}

/**
 * Cache metadata in database
 */
async function cacheMetadata(metadataData) {
    const client = initSupabase();
    if (!client) return;

    try {
        const ttlExpiresAt = new Date(Date.now() + CACHE_CONFIG.METADATA_TTL);
        
        const { error } = await client
            .from('metadata_cache')
            .upsert({
                contract_address: metadataData.contractAddress.toLowerCase(),
                token_id: metadataData.tokenId.toString(),
                cache_key: metadataData.cacheKey,
                metadata: metadataData.metadata,
                image_url: metadataData.metadata.image,
                token_uri: metadataData.tokenUri,
                ttl_expires_at: ttlExpiresAt.toISOString(),
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'cache_key'
            });

        if (error) {
            console.error('Metadata cache store error:', error);
        }
    } catch (error) {
        console.error('Metadata cache store error:', error);
    }
}

/**
 * Update cache hit counter
 */
async function updateCacheHits(cacheId) {
    const client = initSupabase();
    if (!client) return;

    try {
        const { error } = await client
            .from('metadata_cache')
            .update({ 
                hits: client.raw('hits + 1'),
                last_hit: new Date().toISOString()
            })
            .eq('id', cacheId);

        if (error) {
            console.error('Cache hits update error:', error);
        }
    } catch (error) {
        console.error('Cache hits update error:', error);
    }
}

/**
 * Record cache performance metrics
 */
async function recordCacheHit(metricType) {
    const client = initSupabase();
    if (!client) return;

    try {
        await client
            .from('cache_metrics')
            .insert({
                metric_type: metricType,
                cache_type: 'metadata',
                value: 1
            });
    } catch (error) {
        console.error('Metrics recording error:', error);
    }
}

/**
 * Record latency metrics
 */
async function recordLatency(cacheType, latency) {
    const client = initSupabase();
    if (!client) return;

    try {
        await client
            .from('cache_metrics')
            .insert({
                metric_type: 'latency',
                cache_type: cacheType,
                value: latency
            });
    } catch (error) {
        console.error('Latency recording error:', error);
    }
}

/**
 * Check if cache entry is expired
 */
function isExpired(ttlExpiresAt) {
    return new Date(ttlExpiresAt) < new Date();
}