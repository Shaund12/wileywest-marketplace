import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { commitCoveredRange } = require('../../backend/api/sync-listings.js');

describe('listing sync coverage', () => {
    it('advances the bookmark after a fully successful range', async () => {
        const advance = vi.fn();

        const result = await commitCoveredRange(async () => ({ upserted: 1 }), advance, 120);

        expect(result).toEqual({ upserted: 1 });
        expect(advance).toHaveBeenCalledWith(120);
    });

    it('does not advance the bookmark when any range work fails', async () => {
        const advance = vi.fn();

        await expect(commitCoveredRange(async () => {
            throw new Error('ListingCreated 100-120 failed');
        }, advance, 120)).rejects.toThrow('ListingCreated 100-120 failed');

        expect(advance).not.toHaveBeenCalled();
    });
});
