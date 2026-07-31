import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { buildSyncHealth } = require('../../backend/healthPage.js');

describe('sync health', () => {
    it('reports per-chain lag and successful coverage', () => {
        const completedAt = '2026-07-30T20:00:00.000Z';
        const result = buildSyncHealth({
            rows: [{ key: 'listing_events', last_block: 100, updated_at: completedAt }],
            heads: { hyve: 104, vitruveo: 200 },
            runtime: { chainId: 7847, lastSuccessfulRange: { fromBlock: 90, toBlock: 100, completedAt }, failedRange: null, retryCount: 0, lastError: null, discoveredListings: 2, persistedListings: 2 },
            listingCount: 1,
            now: new Date('2026-07-30T20:01:00.000Z').getTime(),
        });

        expect(result.hyve).toMatchObject({ indexedHead: 100, rpcHead: 104, lagBlocks: 4, lagSeconds: 60, discoveredListings: 2, persistedListings: 2, activeListings: 1, cursorAdvancedWithoutCoverage: false });
        expect(result.vitruveo.indexedHead).toBeNull();
    });

    it('alerts when the cursor is ahead of proven coverage', () => {
        const result = buildSyncHealth({
            rows: [{ key: 'listing_events', last_block: 101, updated_at: new Date().toISOString() }],
            heads: { hyve: 101, vitruveo: null },
            runtime: { chainId: 7847, lastSuccessfulRange: { fromBlock: 90, toBlock: 100 }, failedRange: { fromBlock: 101, toBlock: 101 }, retryCount: 2, lastError: 'RPC failed', discoveredListings: 1, persistedListings: 0 },
            listingCount: 1,
        });

        expect(result.hyve.cursorAdvancedWithoutCoverage).toBe(true);
        expect(result.hyve.failedRange).toEqual({ fromBlock: 101, toBlock: 101 });
        expect(result.hyve.lastError).toBe('RPC failed');
    });
});
