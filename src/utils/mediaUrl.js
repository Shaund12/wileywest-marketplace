const THUMBNAIL_WIDTHS = [240, 400, 640, 960];

export function nftThumbnailUrl(url, requestedWidth = 640) {
    if (typeof url !== 'string' || !url.startsWith('/api/ipfs/ipfs/')) return url;
    const width = THUMBNAIL_WIDTHS.reduce(
        (best, candidate) => Math.abs(candidate - requestedWidth) < Math.abs(best - requestedWidth) ? candidate : best,
        THUMBNAIL_WIDTHS[0],
    );
    return url.replace('/api/ipfs/ipfs/', `/api/media/${width}/ipfs/`);
}
