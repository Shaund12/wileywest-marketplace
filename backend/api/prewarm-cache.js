/**
 * Pre-warm cache (ported from api/prewarm-cache.js → pg). Queues and processes
 * metadata/image warming jobs. Calls the sibling metadata-cache / image-proxy
 * endpoints via an internal base URL (INTERNAL_API_BASE, default localhost).
 */
const { pool } = require('../db/pgClient');

const PREWARM_CONFIG = { BATCH_SIZE: 5, NORMAL_PRIORITY: 5 };

function internalBase() {
    return process.env.INTERNAL_API_BASE || `http://127.0.0.1:${process.env.PORT || 8787}`;
}

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') return await handlePrewarmRequest(req, res);
        // Queue processing is an internal cron operation. Exposing it as a
        // public GET lets arbitrary callers force RPC/IPFS work.
        if (req.method === 'GET') return res.status(405).json({ error: 'Queue processing is internal only' });
        return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
        return res.status(500).json({ error: 'Internal server error', message: error.message });
    }
};

async function handlePrewarmRequest(req, res) {
    const { contract, tokenId, listingId, priority = PREWARM_CONFIG.NORMAL_PRIORITY } = req.body || {};
    if (!contract || !tokenId) return res.status(400).json({ error: 'Missing required parameters: contract and tokenId' });
    const { rows } = await pool.query(
        `INSERT INTO prewarm_queue (job_type, contract_address, token_id, listing_id, priority, status)
         VALUES ('listing', $1, $2, $3, $4, 'pending') RETURNING id`,
        [contract.toLowerCase(), tokenId.toString(), listingId || null, parseInt(priority)],
    );
    setTimeout(() => processPrewarmQueue().catch(() => {}), 100);
    return res.json({ success: true, jobId: rows[0].id, message: 'Pre-warm job queued successfully' });
}

async function handleProcessQueue(req, res) {
    const stats = await processPrewarmQueue();
    return res.json({ success: true, message: 'Queue processing completed', stats });
}

async function processPrewarmQueue() {
    const stats = { processed: 0, successful: 0, failed: 0, skipped: 0 };
    const { rows: jobs } = await pool.query(
        `SELECT * FROM prewarm_queue WHERE status = 'pending' AND attempts < 3
         ORDER BY priority DESC, created_at ASC LIMIT $1`, [PREWARM_CONFIG.BATCH_SIZE],
    );
    if (!jobs.length) return stats;
    for (const job of jobs) {
        stats.processed++;
        try {
            await updateJobStatus(job.id, 'processing');
            const result = await processPrewarmJob(job);
            if (result.success) { stats.successful++; await updateJobStatus(job.id, 'completed', null, new Date()); }
            else { stats.failed++; await updateJobStatus(job.id, 'failed', result.error); }
        } catch (e) { stats.failed++; await updateJobStatus(job.id, 'failed', e.message); }
        await new Promise((r) => setTimeout(r, 200));
    }
    return stats;
}

async function processPrewarmJob(job) {
    try {
        const md = await prewarmMetadata(job.contract_address, job.token_id);
        if (!md.success) return { success: false, error: `Metadata pre-warm failed: ${md.error}` };
        await prewarmImages(md.metadata);
        return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
}

async function prewarmMetadata(contractAddress, tokenId) {
    try {
        const r = await fetch(`${internalBase()}/api/metadata-cache?contract=${contractAddress}&tokenId=${tokenId}`, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { success: true, metadata: await r.json() };
    } catch (e) { return { success: false, error: e.message }; }
}

async function prewarmImages(metadata) {
    const urls = [];
    if (metadata.image) urls.push(metadata.image);
    if (metadata.imageUrl && metadata.imageUrl !== metadata.image) urls.push(metadata.imageUrl);
    if (metadata.animationUrl) urls.push(metadata.animationUrl);
    for (const u of urls) {
        try { await fetch(`${internalBase()}/api/image-proxy?url=${encodeURIComponent(u)}`, { headers: { Accept: 'application/json' } }); } catch { /* ignore */ }
    }
}

async function updateJobStatus(jobId, status, errorMessage = null, processedAt = null) {
    try {
        await pool.query(
            `UPDATE prewarm_queue SET status = $2, attempts = attempts + 1, updated_at = NOW(),
               error_message = COALESCE($3, error_message),
               processed_at = COALESCE($4, processed_at)
             WHERE id = $1`,
            [jobId, status, errorMessage, processedAt ? processedAt.toISOString() : null],
        );
    } catch (e) { console.error('Job status update error:', e.message); }
}

module.exports.processPrewarmQueue = processPrewarmQueue;
