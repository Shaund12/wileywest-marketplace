import { describe, expect, it } from 'vitest';
import { normalizeNFTMetadata } from '../../src/utils/nftUtils.js';
import { loadNFTMetadata, resolveImageUrl } from '../../src/utils/metadataLoader.js';

describe('metadata failure states', () => {
    it('keeps the canonical image empty when metadata has no image', () => {
        const result = normalizeNFTMetadata({ name: 'No media' }, '0x123', '7');

        expect(result.image).toBeNull();
        expect(result.imageUrl).toBeNull();
        expect(result.metadataState).toBe('missing_image');
        expect(result.failureProvenance).toBe('metadata_document');
    });

    it('reports unavailable metadata without substituting a stock image', async () => {
        const result = await loadNFTMetadata('', '7', null);

        expect(result.image).toBeNull();
        expect(result.imageUrl).toBeNull();
        expect(result.metadataState).toBe('metadata_unavailable');
        expect(result.failureProvenance).toBe('metadata_loader');
        expect(result.error).toBeTruthy();
    });

    it('signals an absent image without fabricating a fallback URL', async () => {
        const result = await resolveImageUrl(null);

        expect(result.primary).toBeNull();
        expect(result.fallbacks).toEqual([]);
        expect(result.metadataState).toBe('missing_image');
    });

    it('keeps an unrecognized image URI without adding stock-photo fallbacks', async () => {
        const result = await resolveImageUrl('custom://collection/7');

        expect(result.primary).toBe('custom://collection/7');
        expect(result.fallbacks).toEqual([]);
    });
});
