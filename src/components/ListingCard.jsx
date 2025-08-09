import React, { useState, useEffect, useRef } from 'react';
import { ethers } from 'ethers';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { formatPriceWithUSDC, getTokenSymbol, fetchTokenDetails } from '../utils/tokenUtils';
import { resolveCollectionName, normalizeDescription, scopedClass } from '../utils/nftUtils';
import { debugWarn } from '../utils/debugUtils';
import './ListingCard.css';

// ---------------------------------------------
// Robust IPFS/Arweave resolver with live gateway fallback
// ---------------------------------------------

// Fast, reliable gateways first; ipfs.io last (often rate-limited).
const IPFS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipfs/',
    'https://cf-ipfs.com/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://infura-ipfs.io/ipfs/',
    'https://w3s.link/ipfs/',
    'https://nftstorage.link/ipfs/',
    'https://ipfs.io/ipfs/'
];

const IPNS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipns/',
    'https://cf-ipfs.com/ipns/',
    'https://dweb.link/ipns/',
    'https://gateway.pinata.cloud/ipns/',
    'https://infura-ipfs.io/ipns/',
    'https://w3s.link/ipns/',
    'https://nftstorage.link/ipns/',
    'https://ipfs.io/ipns/'
];

// Image URL cache to persist across refreshes (per-contract/token)
const imageUrlCache = {};

/**
 * Normalize a potential IPFS/IPNS/HTTP/AR URL into a list of HTTPS candidates to try.
 */
function expandToCandidateUrls(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const url = raw.trim();

    // data URLs work as-is
    if (url.startsWith('data:')) return [url];

    // arweave
    if (url.startsWith('ar://')) {
        const id = url.replace('ar://', '');
        return [`https://arweave.net/${id}`];
    }
    if (/^https?:\/\/arweave\.net\/.+/i.test(url)) return [url];

    // ipfs://CID[/path]
    if (url.startsWith('ipfs://')) {
        // handle ipfs://ipfs/<cid> and ipfs://<cid>
        let rest = url.slice('ipfs://'.length);
        rest = rest.replace(/^ipfs\//i, ''); // strip optional "ipfs/"
        return IPFS_GATEWAYS.map((g) => g + rest);
    }

    // ipns://NAME[/path]
    if (url.startsWith('ipns://')) {
        let rest = url.slice('ipns://'.length);
        rest = rest.replace(/^ipns\//i, '');
        return IPNS_GATEWAYS.map((g) => g + rest);
    }

    // http(s) ipfs-style paths: .../ipfs/CID/... or .../ipns/NAME/...
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const ipfsIdx = parts.indexOf('ipfs');
        const ipnsIdx = parts.indexOf('ipns');
        if (ipfsIdx !== -1 && parts[ipfsIdx + 1]) {
            const cidAndPath = parts.slice(ipfsIdx + 1).join('/');
            return IPFS_GATEWAYS.map((g) => g + cidAndPath);
        }
        if (ipnsIdx !== -1 && parts[ipnsIdx + 1]) {
            const nameAndPath = parts.slice(ipnsIdx + 1).join('/');
            return IPNS_GATEWAYS.map((g) => g + nameAndPath);
        }
        // plain https url, just try it
        return [url];
    } catch {
        // If it's not a valid URL, treat it as CID-like and spray gateways
        if (/^[a-z0-9]+$/i.test(url)) {
            return IPFS_GATEWAYS.map((g) => g + url);
        }
        return [url];
    }
}

/**
 * Probe image loadability. Resolves the first URL that actually loads.
 * Uses <img> test to bypass CORS/HEAD issues.
 */
function findFirstWorkingImage(candidates, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        if (!candidates || candidates.length === 0) {
            reject(new Error('No candidate URLs to test'));
            return;
        }

        let settled = false;
        let idx = 0;

        const tryNext = () => {
            if (settled) return;
            if (idx >= candidates.length) {
                reject(new Error('No working image gateway found'));
                return;
            }

            const testUrl = candidates[idx++];
            const img = new Image();

            const timer = setTimeout(() => {
                img.onload = null;
                img.onerror = null;
                // move on to next candidate
                tryNext();
            }, timeoutMs);

            img.onload = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(testUrl);
            };
            img.onerror = () => {
                clearTimeout(timer);
                tryNext();
            };
            img.src = testUrl + (testUrl.includes('?') ? '&' : '?') + 'cachebust=' + Date.now();
        };

        tryNext();
    });
}

/**
 * Collect all potential image sources from listing/metadata.
 */
function collectImageSources(listing) {
    const m = listing?.metadata || {};
    const sources = [
        m.image,
        listing.image,
        listing.imageUrl,
        m.image_url,
        m.imageUrl,
        // sometimes "animation_url" actually points to a static image
        m.animation_url,
        m.animationUrl
    ];
    // unique, truthy strings
    const seen = new Set();
    return sources
        .filter((s) => typeof s === 'string' && s.trim() !== '')
        .map((s) => s.trim())
        .filter((s) => {
            if (seen.has(s)) return false;
            seen.add(s);
            return true;
        });
}

/**
 * Resolve a working image URL with caching and multi-gateway fallback.
 */
async function resolveWorkingImageUrl(listing) {
    const cacheKey = `${listing.nftContract}-${listing.tokenId}`;

    if (imageUrlCache[cacheKey]) {
        return imageUrlCache[cacheKey];
    }

    const rawSources = collectImageSources(listing);

    // If nothing provided, bail
    if (rawSources.length === 0) return null;

    // Build a flattened candidate list across all sources/gateways
    const candidates = [];
    const seen = new Set();
    for (const src of rawSources) {
        for (const c of expandToCandidateUrls(src)) {
            if (!seen.has(c)) {
                seen.add(c);
                candidates.push(c);
            }
        }
    }

    // Try to find the first that actually loads
    try {
        const working = await findFirstWorkingImage(candidates);
        imageUrlCache[cacheKey] = working;
        return working;
    } catch (err) {
        debugWarn('No working IPFS/Arweave image URL found for listing', err);
        return null;
    }
}

// ---------------------------------------------
// Component
// ---------------------------------------------

function ListingCard({ listing, featured = false, showSeller = true }) {
    const { buyListing, status } = useMarketplace();
    const { wallet, connect, provider } = useWallet();

    const [tokenSymbol, setTokenSymbol] = useState('TOKEN');
    const [priceDisplay, setPriceDisplay] = useState({
        tokenAmount: '...',
        tokenSymbol: 'TOKEN',
        usdcValue: '0.00',
        formatted: '...',
        hasUSDCRate: true
    });
    const [resolvedImageUrl, setResolvedImageUrl] = useState(null);
    const listingRef = useRef(null);

    useEffect(() => {
        listingRef.current = listing;
    }, [listing]);

    const handleBuy = async () => {
        if (!wallet) {
            await connect();
            return;
        }
        buyListing(listing.id, listing.pricePerUnit, listing.paymentToken);
    };

    const isOwner = wallet && listing.seller.toLowerCase() === wallet.toLowerCase();

    // Resolve and cache image URL when listing changes
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const url = await resolveWorkingImageUrl(listing);
            if (!cancelled) setResolvedImageUrl(url);
        })();
        return () => {
            cancelled = true;
        };
    }, [listing]);

    const imageSeed = `${listing.nftContract}${listing.tokenId}`;
    const nftName = resolveCollectionName(listing);
    const nftDescription = normalizeDescription(listing?.metadata?.description || listing.description);

    // Format price and fetch token details when component mounts or listing changes
    useEffect(() => {
        async function updatePriceDisplay() {
            if (!listing.pricePerUnit || !provider) return;

            try {
                const priceInfo = await formatPriceWithUSDC(
                    listing.pricePerUnit,
                    listing.paymentToken,
                    provider,
                    false
                );

                setPriceDisplay(priceInfo);
                setTokenSymbol(priceInfo.tokenSymbol);
            } catch (error) {
                debugWarn('Error formatting price with USDC:', error);
                const tokenDetails = await fetchTokenDetails(listing.paymentToken, provider).catch(() => ({
                    symbol: getTokenSymbol(listing.paymentToken),
                    decimals: 18
                }));

                setPriceDisplay({
                    tokenAmount: listing.pricePerUnit.toString(),
                    tokenSymbol: tokenDetails.symbol,
                    usdcValue: '0.00',
                    formatted: `${listing.pricePerUnit.toString()} ${tokenDetails.symbol}`,
                    hasUSDCRate: false
                });
                setTokenSymbol(tokenDetails.symbol);
            }
        }

        updatePriceDisplay();
    }, [listing, provider]);

    return (
        <article
            className={`${scopedClass('listing-card', 'ListingCard')} ${featured ? scopedClass('featured', 'ListingCard') : ''}`}
            role="article"
            aria-label={`NFT listing: ${nftName}`}
        >
            <div className={scopedClass('listing-image', 'ListingCard')}>
                <PlaceholderImage
                    src={resolvedImageUrl}
                    alt={`${nftName} - NFT artwork`}
                    className={scopedClass('nft-image', 'ListingCard')}
                    seed={imageSeed}
                    width={300}
                    height={200}
                    contractAddress={listing.nftContract}
                    tokenId={listing.tokenId}
                    metadata={listing.metadata}
                    key={`image-${listing.nftContract}-${listing.tokenId}`}
                />
            </div>

            <div className={scopedClass('listing-details', 'ListingCard')}>
                <div className={scopedClass('listing-info', 'ListingCard')}>
                    <h3 className={scopedClass('listing-title', 'ListingCard')}>{nftName}</h3>
                    <div className={`${scopedClass('listing-contract', 'ListingCard')} ${scopedClass('small', 'ListingCard')}`}>
                        {listing.nftContract.slice(0, 6)}...{listing.nftContract.slice(-4)}
                    </div>
                    {nftDescription && (
                        <p
                            id={`description-${listing.id}`}
                            className={scopedClass('listing-description', 'ListingCard')}
                        >
                            {nftDescription}
                        </p>
                    )}
                </div>

                <div className={scopedClass('listing-price', 'ListingCard')} role="region" aria-label="Price information">
                    {priceDisplay.hasUSDCRate ? (
                        <>
                            <div className={scopedClass('price-amount', 'ListingCard')}>
                                ${priceDisplay.usdcValue}
                            </div>
                            <div className={scopedClass('price-currency', 'ListingCard')}>
                                USDC
                            </div>
                            {priceDisplay.tokenSymbol !== 'USDC.pol' && (
                                <div className={scopedClass('price-original', 'ListingCard')}>
                                    {priceDisplay.tokenAmount} {priceDisplay.tokenSymbol}
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            <div className={scopedClass('price-amount', 'ListingCard')}>
                                {priceDisplay.tokenAmount}
                            </div>
                            <div className={scopedClass('price-currency', 'ListingCard')}>
                                {priceDisplay.tokenSymbol}
                            </div>
                            <div className={scopedClass('price-note', 'ListingCard')}>
                                No USDC rate available
                            </div>
                        </>
                    )}
                </div>

                {showSeller && (
                    <div className={`${scopedClass('listing-seller', 'ListingCard')} ${scopedClass('small', 'ListingCard')}`}>
                        Seller: {listing.seller.slice(0, 6)}...{listing.seller.slice(-4)}
                    </div>
                )}

                <div className={scopedClass('listing-actions', 'ListingCard')}>
                    {isOwner ? (
                        <button
                            className={scopedClass('secondary-button', 'ListingCard')}
                            disabled
                            aria-label="You own this NFT"
                        >
                            You own this
                        </button>
                    ) : (
                        <button
                            className={`${scopedClass('primary-button', 'ListingCard')} ${scopedClass('buy-button', 'ListingCard')}`}
                            onClick={handleBuy}
                            disabled={status.includes('Buying')}
                            aria-label={`Buy ${nftName} for ${priceDisplay.formatted}`}
                            aria-describedby={`price-${listing.id}`}
                        >
                            {status.includes('Buying') ? 'Processing...' : 'Buy Now'}
                        </button>
                    )}
                </div>
            </div>

            {/* Hidden price description for screen readers */}
            <div id={`price-${listing.id}`} className="sr-only">
                Price: {priceDisplay.formatted}
            </div>
        </article>
    );
}

export default ListingCard;
