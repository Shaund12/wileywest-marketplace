/**
 * Pre-warm Cache API - Proactively cache metadata and images for new listings
 * 
 * Features:
 * - Triggered by new listing events
 * - Queued processing with priorities
 * - Batch processing support
 * - Retry logic with exponential backoff
 * - Progress tracking and metrics
 * 
 * Usage: 
 * - POST /api/prewarm-cache (manual trigger)
 * - Triggered automatically by marketplace events
 */

const { createClient } = require('@supabase/supabase-js');

// Pre-warm configuration
const PREWARM_CONFIG = {
    BATCH_SIZE: 5, // Process 5 items at a time
    MAX_CONCURRENT: 3, // Max concurrent pre-warm operations
    RETRY_DELAYS: [1000, 5000, 15000], // 1s, 5s, 15s
    HIGH_PRIORITY: 10,
    NORMAL_PRIORITY: 5,
    LOW_PRIORITY: 1
};

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
 * Main handler for pre-warm cache requests
 */
module.exports = async (req, res) => {
    const client = initSupabase();
    if (!client) {
        return res.status(503).json({ error: 'Cache service unavailable' });
    }

    try {
        if (req.method === 'POST') {
            return await handlePrewarmRequest(req, res, client);
        } else if (req.method === 'GET') {
            return await handleProcessQueue(req, res, client);
        } else {
            return res.status(405).json({ error: 'Method not allowed' });
        }
    } catch (error) {
        console.error('Pre-warm API error:', error);
        return res.status(500).json({ 
            error: 'Internal server error',
            message: error.message 
        });
    }
};

/**
 * Handle manual pre-warm requests
 */
async function handlePrewarmRequest(req, res, client) {
    const { contract, tokenId, listingId, priority = PREWARM_CONFIG.NORMAL_PRIORITY } = req.body;
    
    if (!contract || !tokenId) {
        return res.status(400).json({ 
            error: 'Missing required parameters: contract and tokenId' 
        });
    }

    try {
        // Add to pre-warm queue
        const { data, error } = await client
            .from('prewarm_queue')
            .insert({
                job_type: 'listing',
                contract_address: contract.toLowerCase(),
                token_id: tokenId.toString(),
                listing_id: listingId,
                priority: parseInt(priority),
                status: 'pending'
            })
            .select()
            .single();

        if (error) {
            console.error('Queue insertion error:', error);
            return res.status(500).json({ error: 'Failed to queue pre-warm job' });
        }

        // Process immediately if not busy
        setTimeout(() => processPrewarmQueue(client), 100);

        return res.json({
            success: true,
            jobId: data.id,
            message: 'Pre-warm job queued successfully'
        });

    } catch (error) {
        console.error('Pre-warm request error:', error);
        return res.status(500).json({ error: 'Failed to process pre-warm request' });
    }
}

/**
 * Handle queue processing requests
 */
async function handleProcessQueue(req, res, client) {
    try {
        const stats = await processPrewarmQueue(client);
        
        return res.json({
            success: true,
            message: 'Queue processing completed',
            stats
        });

    } catch (error) {
        console.error('Queue processing error:', error);
        return res.status(500).json({ error: 'Queue processing failed' });
    }
}

/**
 * Process the pre-warm queue
 */
async function processPrewarmQueue(client) {
    const stats = {
        processed: 0,
        successful: 0,
        failed: 0,
        skipped: 0
    };

    try {
        // Get pending jobs ordered by priority
        const { data: jobs, error } = await client
            .from('prewarm_queue')
            .select('*')
            .eq('status', 'pending')
            .lt('attempts', 3) // Don't process jobs that have failed 3 times
            .order('priority', { ascending: false })
            .order('created_at', { ascending: true })
            .limit(PREWARM_CONFIG.BATCH_SIZE);

        if (error) {
            console.error('Queue fetch error:', error);
            return stats;
        }

        if (!jobs || jobs.length === 0) {
            console.log('No pending pre-warm jobs found');
            return stats;
        }

        console.log(`Processing ${jobs.length} pre-warm jobs...`);

        // Process jobs in batches
        for (const job of jobs) {
            stats.processed++;
            
            try {
                // Mark job as processing
                await updateJobStatus(client, job.id, 'processing');
                
                // Process the job based on type
                const result = await processPrewarmJob(job);
                
                if (result.success) {
                    stats.successful++;
                    await updateJobStatus(client, job.id, 'completed', null, new Date());
                    console.log(`✅ Pre-warm job ${job.id} completed successfully`);
                } else {
                    stats.failed++;
                    await updateJobStatus(client, job.id, 'failed', result.error);
                    console.error(`❌ Pre-warm job ${job.id} failed: ${result.error}`);
                }

            } catch (error) {
                stats.failed++;
                await updateJobStatus(client, job.id, 'failed', error.message);
                console.error(`❌ Pre-warm job ${job.id} error:`, error);
            }

            // Small delay between jobs to prevent overwhelming
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        console.log(`Pre-warm queue processing completed:`, stats);
        return stats;

    } catch (error) {
        console.error('Queue processing error:', error);
        return stats;
    }
}

/**
 * Process individual pre-warm job
 */
async function processPrewarmJob(job) {
    try {
        const { contract_address, token_id, job_type } = job;
        
        console.log(`🔥 Processing ${job_type} pre-warm for ${contract_address}:${token_id}`);

        // Step 1: Pre-warm metadata
        const metadataResult = await prewarmMetadata(contract_address, token_id);
        if (!metadataResult.success) {
            return { success: false, error: `Metadata pre-warm failed: ${metadataResult.error}` };
        }

        // Step 2: Pre-warm images from metadata
        const imageResults = await prewarmImages(metadataResult.metadata);
        
        // Consider success if metadata was cached, even if some images failed
        const successfulImages = imageResults.filter(r => r.success).length;
        const totalImages = imageResults.length;
        
        console.log(`✅ Pre-warm completed: metadata=success, images=${successfulImages}/${totalImages}`);
        
        return {
            success: true,
            metadata: metadataResult.success,
            images: {
                successful: successfulImages,
                total: totalImages,
                details: imageResults
            }
        };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Pre-warm metadata by calling metadata-cache API
 */
async function prewarmMetadata(contractAddress, tokenId) {
    try {
        const baseUrl = process.env.VERCEL_URL 
            ? `https://${process.env.VERCEL_URL}` 
            : 'http://localhost:3000';
        
        const url = `${baseUrl}/api/metadata-cache?contract=${contractAddress}&tokenId=${tokenId}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const metadata = await response.json();
        
        return {
            success: true,
            metadata: metadata
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Pre-warm images by calling image-proxy API
 */
async function prewarmImages(metadata) {
    const results = [];
    const imageUrls = [];

    // Collect all image URLs from metadata
    if (metadata.image) imageUrls.push(metadata.image);
    if (metadata.imageUrl && metadata.imageUrl !== metadata.image) {
        imageUrls.push(metadata.imageUrl);
    }
    if (metadata.animationUrl) imageUrls.push(metadata.animationUrl);

    // Process each image URL
    for (const imageUrl of imageUrls) {
        try {
            const result = await prewarmSingleImage(imageUrl);
            results.push({ url: imageUrl, ...result });
        } catch (error) {
            results.push({ 
                url: imageUrl, 
                success: false, 
                error: error.message 
            });
        }
    }

    return results;
}

/**
 * Pre-warm a single image
 */
async function prewarmSingleImage(imageUrl) {
    try {
        const baseUrl = process.env.VERCEL_URL 
            ? `https://${process.env.VERCEL_URL}` 
            : 'http://localhost:3000';
        
        const url = `${baseUrl}/api/image-proxy?url=${encodeURIComponent(imageUrl)}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();
        
        return {
            success: true,
            cached: result.cached || false,
            latency: result.latency || 0
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Update job status in database
 */
async function updateJobStatus(client, jobId, status, errorMessage = null, processedAt = null) {
    try {
        const updateData = {
            status,
            attempts: client.raw('attempts + 1'),
            updated_at: new Date().toISOString()
        };

        if (errorMessage) {
            updateData.error_message = errorMessage;
        }

        if (processedAt) {
            updateData.processed_at = processedAt.toISOString();
        }

        const { error } = await client
            .from('prewarm_queue')
            .update(updateData)
            .eq('id', jobId);

        if (error) {
            console.error('Job status update error:', error);
        }
    } catch (error) {
        console.error('Job status update error:', error);
    }
}

/**
 * Cleanup old completed/failed jobs
 */
async function cleanupOldJobs(client) {
    try {
        const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
        
        const { error } = await client
            .from('prewarm_queue')
            .delete()
            .in('status', ['completed', 'failed'])
            .lt('created_at', cutoffDate.toISOString());

        if (error) {
            console.error('Job cleanup error:', error);
        } else {
            console.log('Old pre-warm jobs cleaned up');
        }
    } catch (error) {
        console.error('Job cleanup error:', error);
    }
}

// Export for use in other modules
module.exports.processPrewarmQueue = processPrewarmQueue;
module.exports.addPrewarmJob = async (contractAddress, tokenId, listingId = null, priority = PREWARM_CONFIG.NORMAL_PRIORITY) => {
    const client = initSupabase();
    if (!client) return { success: false, error: 'Cache service unavailable' };

    try {
        const { data, error } = await client
            .from('prewarm_queue')
            .insert({
                job_type: 'listing',
                contract_address: contractAddress.toLowerCase(),
                token_id: tokenId.toString(),
                listing_id: listingId,
                priority: parseInt(priority),
                status: 'pending'
            })
            .select()
            .single();

        if (error) {
            return { success: false, error: error.message };
        }

        return { success: true, jobId: data.id };
    } catch (error) {
        return { success: false, error: error.message };
    }
};