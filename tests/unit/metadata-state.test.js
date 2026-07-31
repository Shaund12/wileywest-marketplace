import { describe, expect, it } from 'vitest';
import { normalizeNFTMetadata } from '../../src/utils/nftUtils.js';
import { fastResolveIPFS, loadNFTMetadata, resolveImageUrl } from '../../src/utils/metadataLoader.js';

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

    it('canonicalizes repeated IPFS route segments without adding another prefix', async () => {
        const cid = 'bafybeideh5xixahobrmnpfjscjmo76t3pjjjwhbbmaljd4mg6z4lp4f67u';

        const result = await loadNFTMetadata('0x89e5d3b458b95a3f8bc67caa16ee14b38e5a7447', '0', null, {
            name: 'Pixel Ninja Cats #0',
            image: `/api/ipfs/ipfs/ipfs/${cid}`,
        });

        expect(result.image).toBe(`/api/ipfs/ipfs/${cid}`);
        expect(result.imageUrl).toBe(`/api/ipfs/ipfs/${cid}`);
    });

    it('rejects a poisoned cached IPFS path after its CID has been lost', () => {
        expect(fastResolveIPFS('/api/ipfs/ipfs/ipfs')).toBeNull();
    });
});
