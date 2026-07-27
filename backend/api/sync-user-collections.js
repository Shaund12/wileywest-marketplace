/**
 * User collection sync (ported from api/sync-user-collections.js → pg).
 * Scans a wallet's ERC721/ERC1155 holdings and stores them on user_profiles.
 * Only the storage layer changed (Supabase upsert/select → parameterized pg).
 */
const { ethers } = require('ethers');
const { pool } = require('../db/pgClient');

const CONFIG = {
    CHUNK_BLOCKS: parseInt(process.env.NFT_SCAN_CHUNK || '6000', 10),
    MAX_ENUM_721: 4000,
    MAX_METADATA_CONCURRENCY: 25,
    METADATA_TIMEOUT: 20000,
};

const ERC721_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
];
const ERC1155_ABI = [
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function uri(uint256 id) view returns (string)',
    'function supportsInterface(bytes4 interfaceId) view returns (bool)',
];
const ERC1155_IFACE = new ethers.Interface([
    'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
    'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
]);

const KNOWN_NFT_CONTRACTS = [
    '0xaEf0a72A661B82CB1d871FCA5117486C664EeF13', '0x8e7C7f0DF435Be6773641f8cf62C590d7Dde5a8a',
    '0x72D2bFb14b3351d17A63Cd4c8085E034e313c54c', '0xABA06E4A2Eb17C686Fc67C81d26701D9b82e3a41',
    '0xFd1716e05225aFE88F6f6e973A155eb0377e1657', '0x2D732b0Bb33566A13E586aE83fB21d2feE34e906',
];

let provider;
let activeChain;
let syncQueue = Promise.resolve();

const CHAINS = Object.freeze({
    7847: {
        id: 7847,
        name: 'Hyve',
        rpcUrl: process.env.HYVE_RPC_URL || process.env.VITE_RPC_URL || 'https://rpc.hyvechain.com',
        explorer: 'https://explorer.hyvechain.com',
    },
    1490: {
        id: 1490,
        name: 'Vitruveo',
        rpcUrl: process.env.VITRUVEO_RPC_URL || 'https://rpc.vitruveo.ai',
        explorer: 'https://explorer.vitruveo.ai',
    },
});

function init(chainId = 7847) {
    activeChain = CHAINS[Number(chainId)];
    if (!activeChain) throw new Error(`Unsupported chain: ${chainId}`);
    provider = new ethers.JsonRpcProvider(activeChain.rpcUrl, activeChain.id, { staticNetwork: true });
}

// The legacy RPC fallback helpers share provider/chain state. Serialize syncs so
// simultaneous Hyve and Vitruveo requests cannot swap that state mid-scan.
function runOnChain(chainId, task) {
    const run = syncQueue.then(() => {
        init(chainId);
        return task();
    });
    syncQueue = run.catch(() => undefined);
    return run;
}

async function fetchJson(url, timeoutMs) {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return JSON.parse(await res.text());
    } finally { clearTimeout(id); }
}

async function fetchIndexedInventory(wallet) {
    const endpoint = `${activeChain.explorer}/api/v2/addresses/${wallet}/nft`;
    const nfts = [];
    let nextPage = null;
    let pages = 0;

    do {
        const params = new URLSearchParams({ type: 'ERC-721,ERC-1155' });
        if (nextPage) {
            Object.entries(nextPage).forEach(([key, value]) => {
                if (value !== null && value !== undefined) params.set(key, String(value));
            });
        }
        const payload = await fetchJson(`${endpoint}?${params.toString()}`, 12000);
        if (!Array.isArray(payload.items)) throw new Error('Explorer returned an invalid NFT inventory');

        for (const item of payload.items) {
            const token = item.token || {};
            const contractAddress = token.address || token.address_hash;
            if (!contractAddress || !ethers.isAddress(contractAddress) || item.id === null || item.id === undefined) continue;
            const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata : {};
            const image = item.image_url || metadata.image || metadata.image_url || item.media_url || null;
            nfts.push({
                contractAddress: ethers.getAddress(contractAddress),
                tokenId: String(item.id),
                type: String(token.type || '').toUpperCase().includes('1155') ? 'ERC1155' : 'ERC721',
                balance: String(item.value || '1'),
                tokenURI: item.token_uri || null,
                name: metadata.name || `${token.name || 'NFT'} #${item.id}`,
                image,
                imageUrl: image,
                metadata: {
                    ...metadata,
                    image: metadata.image || image,
                    imageUrl: metadata.imageUrl || item.image_url || image,
                },
                collectionName: token.name || null,
                collectionSymbol: token.symbol || null,
                chainId: activeChain.id,
                discoverySource: 'explorer-index',
            });
        }
        nextPage = payload.next_page_params || null;
        pages += 1;
    } while (nextPage && pages < 100);

    return [...new Map(
        nfts.map((nft) => [`${nft.contractAddress.toLowerCase()}:${nft.tokenId}`, nft])
    ).values()];
}

async function classifyContract(address) {
    try { const c = new ethers.Contract(address, ERC721_ABI, provider); if (await c.supportsInterface('0x80ac58cd').catch(() => false)) return 'ERC721'; } catch { /* ignore */ }
    try { const c2 = new ethers.Contract(address, ERC1155_ABI, provider); if (await c2.supportsInterface('0xd9b67a26').catch(() => false)) return 'ERC1155'; } catch { /* ignore */ }
    return null;
}

async function discoverContractsForWallet(wallet, fromBlock, toBlock) {
    const set = new Set(KNOWN_NFT_CONTRACTS.map((a) => a.toLowerCase()));
    const t721 = ethers.id('Transfer(address,address,uint256)');
    const single1155 = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
    const batch1155 = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');
    const walletTopic = ethers.zeroPadValue(wallet.toLowerCase(), 32);
    for (let start = fromBlock; start <= toBlock; start += CONFIG.CHUNK_BLOCKS) {
        const end = Math.min(start + CONFIG.CHUNK_BLOCKS - 1, toBlock);
        try { (await provider.getLogs({ fromBlock: start, toBlock: end, topics: [t721, null, walletTopic] })).forEach((l) => set.add(l.address.toLowerCase())); } catch { /* ignore */ }
        try { (await provider.getLogs({ fromBlock: start, toBlock: end, topics: [single1155, null, null, walletTopic] })).forEach((l) => set.add(l.address.toLowerCase())); } catch { /* ignore */ }
        try { (await provider.getLogs({ fromBlock: start, toBlock: end, topics: [batch1155, null, null, walletTopic] })).forEach((l) => set.add(l.address.toLowerCase())); } catch { /* ignore */ }
    }
    return [...set];
}

async function scanERC721(contractAddr, wallet, fromBlock, toBlock) {
    const out = [];
    const c = new ethers.Contract(contractAddr, ERC721_ABI, provider);
    let enumerable = false;
    try { enumerable = await c.supportsInterface('0x780e9d63').catch(() => false); } catch { /* ignore */ }
    if (!enumerable) { try { if ((await c.balanceOf(wallet)) > 0n) { await c.tokenOfOwnerByIndex(wallet, 0); enumerable = true; } } catch { /* ignore */ } }
    if (enumerable) {
        let balance = 0n; try { balance = await c.balanceOf(wallet); } catch { /* ignore */ }
        for (let i = 0; i < Math.min(Number(balance), CONFIG.MAX_ENUM_721); i++) {
            try {
                const tokenId = await c.tokenOfOwnerByIndex(wallet, i);
                if ((await c.ownerOf(tokenId)).toLowerCase() === wallet.toLowerCase()) {
                    let tokenURI = null; try { tokenURI = await c.tokenURI(tokenId); } catch { /* ignore */ }
                    out.push({ contractAddress: contractAddr, tokenId: tokenId.toString(), type: 'ERC721', balance: '1', tokenURI, metadata: {} });
                }
            } catch { break; }
        }
        return out;
    }
    const t721 = ethers.id('Transfer(address,address,uint256)');
    const walletTopic = ethers.zeroPadValue(wallet.toLowerCase(), 32);
    const tokenIds = new Set();
    for (let start = fromBlock; start <= toBlock; start += CONFIG.CHUNK_BLOCKS) {
        const end = Math.min(start + CONFIG.CHUNK_BLOCKS - 1, toBlock);
        try { (await provider.getLogs({ address: contractAddr, fromBlock: start, toBlock: end, topics: [t721, null, walletTopic] })).forEach((l) => { if (l.topics[3]) tokenIds.add(BigInt(l.topics[3]).toString()); }); } catch { /* ignore */ }
        try { (await provider.getLogs({ address: contractAddr, fromBlock: start, toBlock: end, topics: [t721, walletTopic] })).forEach((l) => { if (l.topics[3]) tokenIds.add(BigInt(l.topics[3]).toString()); }); } catch { /* ignore */ }
    }
    for (const id of tokenIds) {
        try { if ((await c.ownerOf(id)).toLowerCase() === wallet.toLowerCase()) { let tokenURI = null; try { tokenURI = await c.tokenURI(id); } catch { /* ignore */ } out.push({ contractAddress: contractAddr, tokenId: id, type: 'ERC721', balance: '1', tokenURI, metadata: {} }); } } catch { /* ignore */ }
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
        try { (await provider.getLogs({ fromBlock: start, toBlock: end, address: contractAddr, topics: [single, null, null, walletTopic] })).forEach((l) => { if (l.topics[4]) tokenIds.add(BigInt(l.topics[4]).toString()); }); } catch { /* ignore */ }
        try { (await provider.getLogs({ fromBlock: start, toBlock: end, address: contractAddr, topics: [batch, null, null, walletTopic] })).forEach((l) => { try { (ERC1155_IFACE.parseLog(l).args?.ids || []).forEach((id) => tokenIds.add(BigInt(id).toString())); } catch { /* ignore */ } }); } catch { /* ignore */ }
    }
    if (tokenIds.size === 0) for (let i = 1; i <= 25; i++) tokenIds.add(String(i));
    for (const id of tokenIds) {
        try { const bal = await c.balanceOf(wallet, id); if (bal > 0n) { let tokenURI = null; try { tokenURI = await c.uri(id); } catch { /* ignore */ } out.push({ contractAddress: contractAddr, tokenId: id, type: 'ERC1155', balance: bal.toString(), tokenURI, metadata: {} }); } } catch { /* ignore */ }
    }
    return out;
}

async function fetchMetadataInParallel(nfts) {
    const ipfsGateway = 'https://gateway.pinata.cloud/ipfs/';
    for (let i = 0; i < nfts.length; i += CONFIG.MAX_METADATA_CONCURRENCY) {
        const chunk = nfts.slice(i, i + CONFIG.MAX_METADATA_CONCURRENCY);
        await Promise.allSettled(chunk.map(async (n) => {
            if (!n.tokenURI) return;
            let uri = n.tokenURI; if (uri.startsWith('ipfs://')) uri = `${ipfsGateway}${uri.slice(7)}`;
            try { const meta = await fetchJson(uri, CONFIG.METADATA_TIMEOUT); let image = meta.image || meta.image_url || null; if (image?.startsWith('ipfs://')) image = `${ipfsGateway}${image.slice(7)}`; n.metadata = { ...meta }; n.image = image; n.name = meta.name || null; } catch { /* ignore */ }
        }));
    }
    return nfts;
}

async function getProfile(wallet, chainId) {
    const { rows } = await pool.query(
        `SELECT last_full_scan_block, nfts FROM user_profiles WHERE wallet_address = $1 AND chain_id = $2`,
        [wallet.toLowerCase(), chainId],
    );
    return rows[0] || null;
}

async function upsertProfile(wallet, data) {
    // Build a dynamic upsert over the known profile columns present in `data`.
    const allowed = ['chain_id', 'nfts', 'listings', 'balance', 'last_full_scan_block', 'sync_status', 'last_sync'];
    const keys = Object.keys(data).filter((k) => allowed.includes(k));
    const cols = ['wallet_address', ...keys];
    const vals = [wallet.toLowerCase(), ...keys.map((k) => (data[k] && typeof data[k] === 'object' ? JSON.stringify(data[k]) : data[k]))];
    const placeholders = cols.map((_, i) => `$${i + 1}`);
    const updates = keys.map((k) => `"${k}" = EXCLUDED."${k}"`).concat('updated_at = NOW()');
    await pool.query(
        `INSERT INTO user_profiles (${cols.map((c) => `"${c}"`).join(', ')}, updated_at)
         VALUES (${placeholders.join(', ')}, NOW())
         ON CONFLICT (wallet_address, chain_id) DO UPDATE SET ${updates.join(', ')}`,
        vals,
    );
}

async function fullOrIncrementalScan(wallet, fullRescan = false) {
    const latest = await provider.getBlockNumber();
    const existing = await getProfile(wallet, activeChain.id);

    // Blockscout's owner index is authoritative for current holdings and works
    // even when the public chain RPC has pruned old event history.
    try {
        const indexedNfts = await fetchIndexedInventory(wallet);
        await upsertProfile(wallet, {
            chain_id: activeChain.id,
            nfts: indexedNfts,
            last_full_scan_block: latest,
            sync_status: 'completed',
            last_sync: new Date().toISOString(),
        });
        return {
            count: indexedNfts.length,
            nfts: indexedNfts.length,
            fromBlock: null,
            toBlock: latest,
            contracts: new Set(indexedNfts.map((nft) => nft.contractAddress.toLowerCase())).size,
            mode: 'indexed',
            chainId: activeChain.id,
        };
    } catch (indexError) {
        console.warn(`[collection sync] ${activeChain.name} explorer index unavailable: ${indexError.message}`);
        if (existing && Array.isArray(existing.nfts)) {
            await upsertProfile(wallet, {
                chain_id: activeChain.id,
                sync_status: 'stale',
                last_sync: new Date().toISOString(),
            });
            return {
                count: existing.nfts.length,
                nfts: existing.nfts.length,
                fromBlock: null,
                toBlock: latest,
                contracts: new Set(existing.nfts.map((nft) => nft.contractAddress?.toLowerCase()).filter(Boolean)).size,
                mode: 'cached',
                chainId: activeChain.id,
            };
        }
        if (process.env.ENABLE_RPC_NFT_FALLBACK !== 'true') {
            throw new Error(`${activeChain.name} NFT index is temporarily unavailable`);
        }
        console.warn(`[collection sync] ${activeChain.name} using explicitly enabled RPC fallback`);
    }

    const isFirstProfile = !existing || typeof existing.last_full_scan_block !== 'number';
    const fromBlock = (fullRescan || isFirstProfile) ? 0 : Math.max(0, Number(existing.last_full_scan_block) + 1);
    const toBlock = latest;

    const contracts = await discoverContractsForWallet(wallet, fromBlock, toBlock);
    const results = [];
    for (const addr of contracts) {
        const type = await classifyContract(addr);
        if (type === 'ERC721') results.push(...await scanERC721(addr, wallet, fromBlock, toBlock));
        else if (type === 'ERC1155') results.push(...await scanERC1155(addr, wallet, fromBlock, toBlock));
    }
    await fetchMetadataInParallel(results);

    let merged = results;
    if (!fullRescan && !isFirstProfile && Array.isArray(existing.nfts)) {
        const seen = new Set(results.map((n) => `${n.contractAddress}-${n.tokenId}`));
        merged = [...existing.nfts.filter((n) => !seen.has(`${n.contractAddress}-${n.tokenId}`)), ...results];
    }

    const tagged = merged.map((nft) => ({ ...nft, chainId: activeChain.id }));
    await upsertProfile(wallet, { chain_id: activeChain.id, nfts: tagged, last_full_scan_block: toBlock, sync_status: 'completed' });
    return { count: tagged.length, nfts: tagged.length, fromBlock, toBlock, contracts: contracts.length, mode: (fullRescan || isFirstProfile) ? 'full' : 'incremental', chainId: activeChain.id };
}

async function immediateSync(wallet, fullRescan) {
    await upsertProfile(wallet, { chain_id: activeChain.id, sync_status: 'running', last_sync: new Date().toISOString() });
    try {
        const stats = await fullOrIncrementalScan(wallet, fullRescan);
        return { success: true, wallet, nfts: stats.count, stats, mode: stats.mode };
    } catch (e) {
        await upsertProfile(wallet, { chain_id: activeChain.id, sync_status: 'error' });
        throw e;
    }
}

module.exports = async function handler(req, res) {
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    const start = Date.now();
    try {
        const body = req.method === 'POST' ? req.body || {} : {};
        const wallet = body.walletAddress;
        const chainId = Number(body.chainId || 7847);
        if (!CHAINS[chainId]) return res.status(400).json({ error: `Unsupported chain: ${body.chainId}` });
        if (wallet && body.immediate === true) {
            if (!ethers.isAddress(wallet)) return res.status(400).json({ error: 'Invalid wallet address' });
            const out = await runOnChain(chainId, () => immediateSync(wallet, body.fullRescan === true));
            return res.status(200).json({ success: true, type: 'immediate', ...out, durationMs: Date.now() - start });
        }
        return res.status(200).json({ success: true, message: 'Provide {walletAddress, immediate:true} POST body to trigger sync', durationMs: Date.now() - start });
    } catch (e) {
        return res.status(500).json({ error: e.message, durationMs: Date.now() - start });
    }
};
