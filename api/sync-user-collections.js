/**
 * Enhanced full-chain NFT sync with:
 * - Genesis scan (block 0) chunked (CONFIG.CHUNK_BLOCKS)
 * - Incremental mode using last_full_scan_block
 * - Progressive metadata fetch & caching
 * - Immediate fullRescan trigger via POST body { walletAddress, immediate:true, fullRescan:true }
 */
const { ethers } = require('ethers');
const { createClient } = require('@supabase/supabase-js');

const CONFIG = {
    CHUNK_BLOCKS: parseInt(process.env.NFT_SCAN_CHUNK || '6000', 10),
    MAX_ENUM_721: 4000,
    MAX_METADATA_CONCURRENCY: 25,
    METADATA_TIMEOUT: 20000
};

const ERC721_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)'
];
const ERC1155_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function uri(uint256 id) view returns (string)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
    // events for parsing
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
];

const ERC1155_IFACE = new ethers.Interface([
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
]);

// Import known collections for comprehensive scanning
const KNOWN_COLLECTIONS_REGISTRY = {
    '0xaEf0a72A661B82CB1d871FCA5117486C664EeF13': { name: 'Vitruveo Core NFT', symbol: 'VCORE' },
    '0x8e7C7f0DF435Be6773641f8cf62C590d7Dde5a8a': { name: 'Vitruveo Income Building Engine', symbol: 'VIBE' },
    '0x72D2bFb14b3351d17A63Cd4c8085E034e313c54c': { name: 'Vitruveo Entertainment Revenue Sharing Engine', symbol: 'VERSE' },
    '0xABA06E4A2Eb17C686Fc67C81d26701D9b82e3a41': { name: 'Vortex', symbol: 'VTX' },
    '0xFd1716e05225aFE88F6f6e973A155eb0377e1657': { name: 'MintPlace', symbol: 'MPX' },
    '0xd2c4fb77517bC8D1A9dA13dbEA0Bf4B8B29037dD': { name: 'VTRU Boosters V2', symbol: 'VBOOST' },
    '0x5c7421fcCA16C685cEC5aaFf745a9a6BDf75Ba06': { name: 'Vitruveo Collector Credit', symbol: 'VCOLC' },
    '0x8246eb7D32416888aBeB23b1E715ee5A156d3aBe': { name: 'VTRU Boosters', symbol: 'VBOOST' },
    '0x855B9fa4bb3af6d5947552830eA09f74d3F6d620': { name: 'Sabong Evolution Hatchling', symbol: 'SHAT' },
    '0x047aeA572c510ecE553151E0dAa4fd84AC69928E': { name: 'Sabong Studios Share Units', symbol: 'S3U' },
    '0x20152506e44bA17f73DBf8fED08d23156A0344F9': { name: 'Swoops', symbol: 'Swoops' },
    '0xAA5B03A28D47f29d5bCB81BB7d29a9567df785cf': { name: 'SIC (SOCHAI Insiders Club)', symbol: 'SIC' },
    '0x97336ac0c0Ba1b5B4CaE5D3ed65714cdE1c86B5c': { name: 'Sabong Evolution Partner NFT', symbol: 'SEP' },
    '0x89207A7F75C9cb7C8f95f0c2517b029BE1AE29b8': { name: 'neoNKatz', symbol: 'NK' },
    '0x96Fb9a1Cb848865d8B7698ab3F645B85F37888b8': { name: 'Vitruveo v3 DEX Income', symbol: 'VITDEX' },
    '0xA1508636fFDbaB8b038F705E87EF7F43b7c59d7F': { name: 'VNFTz', symbol: 'VNFTz' },
    '0x9acbDedd548De51615Ff2adbA468075330853215': { name: 'VMonsters', symbol: 'VMON' },
    '0xc5d518d131738481947cFa4670F94eb7b948a1ac': { name: 'V-Share', symbol: 'VSHARE' },
    '0xE1A5518CEbd226FE2a3251F93A1F6AAef65d3131': { name: 'Skoollz NFT Collection', symbol: 'SKLZ' },
    '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906': { name: 'Pixel Ninja Cats', symbol: 'PNCAT' }
};

const KNOWN_NFT_CONTRACTS = [
    ...Object.keys(KNOWN_COLLECTIONS_REGISTRY)
];

let provider;
let supabase;

function init() {
    const rpcUrl = process.env.VITE_RPC_URL || 'https://rpc.vitruveo.xyz';
    provider = new ethers.JsonRpcProvider(rpcUrl);
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) throw new Error('Supabase credentials missing');
    supabase = createClient(supabaseUrl, supabaseKey);
}

async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        clearTimeout(id);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const txt = await res.text();
        return JSON.parse(txt);
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

async function classifyContract(address) {
    try {
        const c = new ethers.Contract(address, ERC721_ABI, provider);
        const sup = await c.supportsInterface('0x80ac58cd').catch(() => false);
        if (sup) return 'ERC721';
    } catch { }
    try {
        const c2 = new ethers.Contract(address, ERC1155_ABI, provider);
        const sup2 = await c2.supportsInterface('0xd9b67a26').catch(() => false);
        if (sup2) return 'ERC1155';
    } catch { }
    return null;
}

async function discoverContractsForWallet(wallet, fromBlock, toBlock) {
    const set = new Set(KNOWN_NFT_CONTRACTS.map(a => a.toLowerCase()));
    const transferTopic721 = ethers.id('Transfer(address,address,uint256)');
    const single1155 = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
    const batch1155 = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');
    const walletTopic = ethers.zeroPadValue(wallet.toLowerCase(), 32);
    for (let start = fromBlock; start <= toBlock; start += CONFIG.CHUNK_BLOCKS) {
        const end = Math.min(start + CONFIG.CHUNK_BLOCKS - 1, toBlock);
        try {
            const logs721In = await provider.getLogs({ fromBlock: start, toBlock: end, topics: [transferTopic721, null, walletTopic] });
            logs721In.forEach(l => set.add(l.address.toLowerCase()));
        } catch { }
        try {
            const sLogs = await provider.getLogs({ fromBlock: start, toBlock: end, topics: [single1155, null, null, walletTopic] });
            sLogs.forEach(l => set.add(l.address.toLowerCase()));
        } catch { }
        try {
            const bLogs = await provider.getLogs({ fromBlock: start, toBlock: end, topics: [batch1155, null, null, walletTopic] });
            bLogs.forEach(l => set.add(l.address.toLowerCase()));
        } catch { }
    }
    return [...set];
}

// ERC721 scan with fallback: try Enumerable, else parse logs, then ownerOf to confirm
async function scanERC721(contractAddr, wallet, fromBlock, toBlock) {
    const out = [];
    const c = new ethers.Contract(contractAddr, ERC721_ABI, provider);

    // Try enumerable path if supported
    let enumerable = false;
    try {
        enumerable = await c.supportsInterface('0x780e9d63').catch(() => false); // ERC721Enumerable
    } catch { }

    if (!enumerable) {
        // Probe tokenOfOwnerByIndex; some contracts don't advertise but still implement
        try {
            const bal = await c.balanceOf(wallet);
            if (bal > 0n) {
                await c.tokenOfOwnerByIndex(wallet, 0); // probe
                enumerable = true;
            }
        } catch { }
    }

    if (enumerable) {
        let balance = 0n;
        try { balance = await c.balanceOf(wallet); } catch { }
        if (balance > 0n) {
            for (let i = 0; i < Math.min(Number(balance), CONFIG.MAX_ENUM_721); i++) {
                try {
                    const tokenId = await c.tokenOfOwnerByIndex(wallet, i);
                    const owner = await c.ownerOf(tokenId);
                    if (owner.toLowerCase() === wallet.toLowerCase()) {
                        let tokenURI = null;
                        try { tokenURI = await c.tokenURI(tokenId); } catch { }
                        out.push({
                            contractAddress: contractAddr,
                            tokenId: tokenId.toString(),
                            type: 'ERC721',
                            balance: '1',
                            tokenURI,
                            metadata: {}
                        });
                    }
                } catch { break; }
            }
        }
        return out;
    }

    // Fallback: parse logs to discover candidate tokenIds, then verify ownerOf
    const transferTopic721 = ethers.id('Transfer(address,address,uint256)');
    const walletTopic = ethers.zeroPadValue(wallet.toLowerCase(), 32);
    const tokenIds = new Set();

    for (let start = fromBlock; start <= toBlock; start += CONFIG.CHUNK_BLOCKS) {
        const end = Math.min(start + CONFIG.CHUNK_BLOCKS - 1, toBlock);
        try {
            // to = wallet
            const toLogs = await provider.getLogs({ address: contractAddr, fromBlock: start, toBlock: end, topics: [transferTopic721, null, walletTopic] });
            toLogs.forEach(l => { const tid = l.topics[3]; if (tid) tokenIds.add(BigInt(tid).toString()); });
        } catch { }
        try {
            // from = wallet
            const fromLogs = await provider.getLogs({ address: contractAddr, fromBlock: start, toBlock: end, topics: [transferTopic721, walletTopic] });
            fromLogs.forEach(l => { const tid = l.topics[3]; if (tid) tokenIds.add(BigInt(tid).toString()); });
        } catch { }
    }

    for (const id of tokenIds) {
        try {
            const owner = await c.ownerOf(id);
            if (owner.toLowerCase() === wallet.toLowerCase()) {
                let tokenURI = null;
                try { tokenURI = await c.tokenURI(id); } catch { }
                out.push({
                    contractAddress: contractAddr,
                    tokenId: id,
                    type: 'ERC721',
                    balance: '1',
                    tokenURI,
                    metadata: {}
                });
            }
        } catch { }
    }
    return out;
}

async function scanERC1155(contractAddr, wallet, fromBlock, toBlock) {
    const out = [];
    const c = new ethers.Contract(contractAddr, ERC1155_ABI, provider);
    const single = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
    const batch = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');
    const walletTopic = ethers.zeroPadValue(wallet.toLowerCase(), 32);
    const tokenIds = new Set();

    for (let start = fromBlock; start <= toBlock; start += CONFIG.CHUNK_BLOCKS) {
        const end = Math.min(start + CONFIG.CHUNK_BLOCKS - 1, toBlock);
        try {
            const sLogs = await provider.getLogs({ fromBlock: start, toBlock: end, address: contractAddr, topics: [single, null, null, walletTopic] });
            sLogs.forEach(l => {
                const tid = l.topics[4]; // id is indexed in TransferSingle
                if (tid) tokenIds.add(BigInt(tid).toString());
            });
        } catch { }
        try {
            const bLogs = await provider.getLogs({ fromBlock: start, toBlock: end, address: contractAddr, topics: [batch, null, null, walletTopic] });
            // Parse ids from data for TransferBatch
            bLogs.forEach(l => {
                try {
                    const parsed = ERC1155_IFACE.parseLog(l);
                    const ids = parsed.args?.ids || [];
                    ids.forEach(id => tokenIds.add(BigInt(id).toString()));
                } catch { }
            });
        } catch { }
    }

    // If nothing discovered via logs, probe first 25 ids as last resort
    if (tokenIds.size === 0) {
        for (let i = 1; i <= 25; i++) tokenIds.add(String(i));
    }

    for (const id of tokenIds) {
        try {
            const bal = await c.balanceOf(wallet, id);
            if (bal > 0n) {
                let tokenURI = null;
                try { tokenURI = await c.uri(id); } catch { }
                out.push({
                    contractAddress: contractAddr,
                    tokenId: id,
                    type: 'ERC1155',
                    balance: bal.toString(),
                    tokenURI,
                    metadata: {}
                });
            }
        } catch { }
    }
    return out;
}

async function fetchMetadataInParallel(nfts) {
    const ipfsGateway = 'https://gateway.pinata.cloud/ipfs/';
    const chunks = [];
    for (let i = 0; i < nfts.length; i += CONFIG.MAX_METADATA_CONCURRENCY) {
        chunks.push(nfts.slice(i, i + CONFIG.MAX_METADATA_CONCURRENCY));
    }
    for (const chunk of chunks) {
        await Promise.allSettled(chunk.map(async (n) => {
            if (!n.tokenURI) return;
            let uri = n.tokenURI;
            if (uri.startsWith('ipfs://')) uri = `${ipfsGateway}${uri.slice(7)}`;
            try {
                const meta = await fetchJson(uri, CONFIG.METADATA_TIMEOUT);
                let image = meta.image || meta.image_url || null;
                if (image && image.startsWith('ipfs://')) image = `${ipfsGateway}${image.slice(7)}`;
                n.metadata = { ...meta };
                n.image = image;
                n.name = meta.name || null;
            } catch {
                // ignore
            }
        }));
    }
    return nfts;
}

async function upsertProfile(wallet, data) {
    await supabase.from('user_profiles').upsert({
        wallet_address: wallet.toLowerCase(),
        ...data,
        updated_at: new Date().toISOString()
    });
}

async function fullOrIncrementalScan(wallet, fullRescan = false) {
    const latest = await provider.getBlockNumber();
    let fromBlock = 0;
    let lastFull = null;

    const { data: existing } = await supabase
        .from('user_profiles')
        .select('last_full_scan_block,nfts')
        .eq('wallet_address', wallet.toLowerCase())
        .single();

    if (existing && existing.last_full_scan_block && !fullRescan) {
        fromBlock = existing.last_full_scan_block + 1;
        lastFull = existing.last_full_scan_block;
    }

    const toBlock = latest;
    const contracts = await discoverContractsForWallet(wallet, fullRescan ? 0 : fromBlock, toBlock);

    const results = [];
    for (const addr of contracts) {
        const type = await classifyContract(addr);
        if (!type) continue;
        if (type === 'ERC721') {
            const items = await scanERC721(addr, wallet, fullRescan ? 0 : fromBlock, toBlock);
            results.push(...items);
        } else {
            const items = await scanERC1155(addr, wallet, fullRescan ? 0 : fromBlock, toBlock);
            results.push(...items);
        }
    }

    await fetchMetadataInParallel(results);

    // Merge with existing NFTs (preserve old if incremental & no duplicates)
    let merged = results;
    if (existing && Array.isArray(existing.nfts) && !fullRescan) {
        const seen = new Set(results.map(n => `${n.contractAddress}-${n.tokenId}`));
        const retained = existing.nfts.filter(n => !seen.has(`${n.contractAddress}-${n.tokenId}`));
        merged = [...retained, ...results];
    }

    // Always advance the scan marker to the latest block scanned
    await upsertProfile(wallet, {
        nfts: merged,
        last_full_scan_block: latest, // fix: advance marker for incremental scans
        sync_status: 'completed'
    });

    return { count: merged.length, fromBlock: fullRescan ? 0 : (existing?.last_full_scan_block ?? 0), toBlock: latest, contracts: contracts.length };
}

async function immediateSync(wallet, fullRescan) {
    await upsertProfile(wallet, { sync_status: 'running', last_sync: new Date().toISOString() });
    try {
        const stats = await fullOrIncrementalScan(wallet, fullRescan);
        return {
            success: true,
            wallet,
            nfts: stats.count,
            stats, // include stats for frontend compatibility (expects stats.nfts)
            mode: fullRescan ? 'full' : 'incremental'
        };
    } catch (e) {
        await upsertProfile(wallet, { sync_status: 'error' });
        throw e;
    }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!['GET', 'POST'].includes(req.method)) {
        return res.status(405).json({ error: 'Method not allowed' });
    }
    const start = Date.now();
    try {
        init();
        const body = req.method === 'POST' ? (req.body || {}) : {};
        const wallet = body.walletAddress;
        const immediate = body.immediate === true;
        const fullRescan = body.fullRescan === true;
        if (wallet && immediate) {
            const out = await immediateSync(wallet, fullRescan);
            return res.status(200).json({
                success: true,
                type: 'immediate',
                ...out,
                durationMs: Date.now() - start
            });
        }
        return res.status(200).json({
            success: true,
            message: 'Provide {walletAddress, immediate:true} POST body to trigger sync',
            durationMs: Date.now() - start
        });
    } catch (e) {
        return res.status(500).json({ error: e.message, durationMs: Date.now() - start });
    }
};