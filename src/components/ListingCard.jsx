import React, { useState, useEffect, useRef } from 'react';
// NOTE: removed unused ethers import
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { formatPriceWithUSDC, getTokenSymbol, fetchTokenDetails } from '../utils/tokenUtils';
import { resolveCollectionName, normalizeDescription, scopedClass } from '../utils/nftUtils';
import { debugWarn } from '../utils/debugUtils';
import './ListingCard.css';

/* =========================
   Error Boundary (prevents white-screen)
   ========================= */
class CardBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { err: null };
    }
    static getDerivedStateFromError(error) {
        return { err: error };
    }
    componentDidCatch(error, info) {
        // eslint-disable-next-line no-console
        console.error('ListingCard error:', error, info);
    }
    render() {
        if (this.state.err) {
            return (
                <div style={{
                    padding: '12px',
                    border: '1px solid #d33',
                    borderRadius: 8,
                    background: 'rgba(255,0,0,0.08)',
                    color: '#f44',
                    fontSize: 14
                }}>
                    <strong>Card crashed:</strong> {String(this.state.err?.message || this.state.err)}
                </div>
            );
        }
        return this.props.children;
    }
}

/* =========================
   Deterministic SVG fallback
   ========================= */
function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

function svgFallbackDataUrl({ seed = 'nft', width = 300, height = 200, title = '' }) {
    const h = hashString(seed);
    const hue = h % 360;
    const hue2 = (hue + 180) % 360;
    const gradId = `g${(h % 1e9).toString(36)}`;
    const block = (h % 7) + 3;

    const label = title ? title.slice(0, 22) : 'Vitruveo NFT';

    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},70%,18%)"/>
      <stop offset="100%" stop-color="hsl(${hue2},70%,16%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#${gradId})"/>
  ${Array.from({ length: block }).map((_, i) => {
        const a = (h + i * 97) % 360;
        const r = 14 + ((h >> i) % 40);
        const cx = (width / (block + 1)) * (i + 1);
        const cy = (height / (block + 1)) * ((i % 3) + 1);
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsla(${a},70%,60%,0.25)"/>`;
    }).join('')}
  <text x="50%" y="${height - 14}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" font-size="14" fill="rgba(255,255,255,0.9)" text-anchor="middle">
    ${label}
  </text>
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* =========================
   Inline PlaceholderImage
   - Uses provided src
   - Falls back to pretty SVG if load fails or no src
   ========================= */
function PlaceholderImage({
    src,
    alt = '',
    className,
    seed = 'nft',
    width = 300,
    height = 200,
    metadata = {}
}) {
    const [finalSrc, setFinalSrc] = useState(
        src || svgFallbackDataUrl({ seed, width, height, title: metadata?.name || '' })
    );
    const [failed, setFailed] = useState(!src);

    useEffect(() => {
        // when src changes, try it; if absent, fallback immediately
        if (src) {
            setFailed(false);
            setFinalSrc(src);
        } else {
            setFailed(true);
            setFinalSrc(svgFallbackDataUrl({ seed, width, height, title: metadata?.name || '' }));
        }
    }, [src, seed, width, height, metadata?.name]);

    const handleError = () => {
        if (!failed) {
            setFailed(true);
            setFinalSrc(svgFallbackDataUrl({ seed, width, height, title: metadata?.name || '' }));
        }
    };

    return (
        <img
            src={finalSrc}
            alt={alt}
            className={className}
            width={width}
            height={height}
            loading="lazy"
            onError={handleError}
            crossOrigin="anonymous"
            style={{ objectFit: 'cover', display: 'block', borderRadius: 8 }}
        />
    );
}

/* =========================
   Robust IPFS/Arweave resolver
   ========================= */
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

const imageUrlCache = {};

const safeStr = (v, d = '') => (typeof v === 'string' ? v : d);
const shortAddr = (a) => (a && a.length > 9 ? `${a.slice(0, 6)}...${a.slice(-4)}` : (a || '—'));

function expandToCandidateUrls(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const url = raw.trim();
    if (url.startsWith('data:')) return [url];

    if (url.startsWith('ar://')) {
        const id = url.replace('ar://', '');
        return [`https://arweave.net/${id}`];
    }
    if (/^https?:\/\/arweave\.net\/.+/i.test(url)) return [url];

    if (url.startsWith('ipfs://')) {
        let rest = url.slice('ipfs://'.length);
        rest = rest.replace(/^ipfs\//i, '');
        return IPFS_GATEWAYS.map((g) => g + rest);
    }

    if (url.startsWith('ipns://')) {
        let rest = url.slice('ipns://'.length);
        rest = rest.replace(/^ipns\//i, '');
        return IPNS_GATEWAYS.map((g) => g + rest);
    }

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
        return [url];
    } catch {
        if (/^[a-z0-9]+$/i.test(url)) {
            return IPFS_GATEWAYS.map((g) => g + url);
        }
        return [url];
    }
}

function findFirstWorkingImage(candidates, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        if (!candidates?.length) return reject(new Error('No candidate URLs to test'));
        if (typeof window === 'undefined') return reject(new Error('SSR: window unavailable'));

        let settled = false;
        let idx = 0;

        const tryNext = () => {
            if (settled) return;
            if (idx >= candidates.length) return reject(new Error('No working image gateway found'));

            const url = candidates[idx++];
            const img = new Image();
            const timer = setTimeout(() => {
                img.onload = null; img.onerror = null;
                tryNext();
            }, timeoutMs);

            img.onload = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(url);
            };
            img.onerror = () => {
                clearTimeout(timer);
                tryNext();
            };
            img.src = url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now();
        };

        tryNext();
    });
}

function collectImageSources(listing) {
    const m = listing?.metadata || {};
    const sources = [
        m.image,
        listing?.image,
        listing?.imageUrl,
        m.image_url,
        m.imageUrl,
        m.animation_url,
        m.animationUrl
    ];
    const seen = new Set();
    return sources
        .filter((s) => typeof s === 'string' && s.trim())
        .map((s) => s.trim())
        .filter((s) => (seen.has(s) ? false : (seen.add(s), true)));
}

async function resolveWorkingImageUrl(listing) {
    const cacheKey = `${safeStr(listing?.nftContract)}-${safeStr(listing?.tokenId)}`;
    if (imageUrlCache[cacheKey]) return imageUrlCache[cacheKey];

    const rawSources = collectImageSources(listing);
    if (!rawSources.length) return null;

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

    try {
        const working = await findFirstWorkingImage(candidates);
        imageUrlCache[cacheKey] = working;
        return working;
    } catch (err) {
        debugWarn?.('No working IPFS/Arweave image URL found for listing', err);
        return null;
    }
}

/* =========================
   Listing Card (hardened)
   ========================= */
function ListingCardInner({ listing, featured = false, showSeller = true }) {
    const { buyListing, status } = useMarketplace?.() || {};
    const { wallet, connect, provider } = useWallet?.() || {};

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

    useEffect(() => { listingRef.current = listing; }, [listing]);

    const handleBuy = async () => {
        if (!wallet) {
            await connect?.();
            return;
        }
        if (!buyListing) return;
        if (!listing?.id || !listing?.pricePerUnit || !listing?.paymentToken) return;
        buyListing(listing.id, listing.pricePerUnit, listing.paymentToken);
    };

    const seller = safeStr(listing?.seller);
    const isOwner = seller && wallet && safeStr(wallet).toLowerCase() === seller.toLowerCase();

    // Resolve image URL
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const url = await resolveWorkingImageUrl(listing || {});
                if (!cancelled) setResolvedImageUrl(url);
            } catch (e) {
                debugWarn?.('resolveWorkingImageUrl failed', e);
                if (!cancelled) setResolvedImageUrl(null);
            }
        })();
        return () => { cancelled = true; };
    }, [listing?.nftContract, listing?.tokenId, listing?.metadata, listing?.image, listing?.imageUrl]);

    const imageSeed = `${safeStr(listing?.nftContract)}${safeStr(listing?.tokenId)}`;
    const nftName = resolveCollectionName?.(listing || {}) || 'Untitled NFT';
    const nftDescription = normalizeDescription?.(safeStr(listing?.metadata?.description) || safeStr(listing?.description)) || '';

    // Price formatting
    useEffect(() => {
        (async () => {
            if (!listing?.pricePerUnit || !listing?.paymentToken || !provider) return;

            try {
                const priceInfo = await formatPriceWithUSDC(
                    listing.pricePerUnit,
                    listing.paymentToken,
                    provider,
                    false
                );
                setPriceDisplay(priceInfo);
                setTokenSymbol(priceInfo?.tokenSymbol || 'TOKEN');
            } catch (error) {
                debugWarn?.('Error formatting price with USDC:', error);
                let tokenDetails = { symbol: getTokenSymbol?.(listing.paymentToken) || 'TOKEN', decimals: 18 };
                try {
                    const fetched = await fetchTokenDetails?.(listing.paymentToken, provider);
                    if (fetched?.symbol) tokenDetails = fetched;
                } catch { }
                setPriceDisplay({
                    tokenAmount: String(listing.pricePerUnit),
                    tokenSymbol: tokenDetails.symbol,
                    usdcValue: '0.00',
                    formatted: `${String(listing.pricePerUnit)} ${tokenDetails.symbol}`,
                    hasUSDCRate: false
                });
                setTokenSymbol(tokenDetails.symbol);
            }
        })();
    }, [listing?.pricePerUnit, listing?.paymentToken, provider]);

    const buying = typeof status === 'string' && status.includes('Buying');
    const nftContract = safeStr(listing?.nftContract);
    const tokenId = safeStr(listing?.tokenId);

    return (
        <article
            className={`${scopedClass?.('listing-card', 'ListingCard') || 'listing-card'} ${featured ? (scopedClass?.('featured', 'ListingCard') || 'featured') : ''}`}
            role="article"
            aria-label={`NFT listing: ${nftName}`}
        >
            <div className={scopedClass?.('listing-image', 'ListingCard') || 'listing-image'}>
                <PlaceholderImage
                    src={resolvedImageUrl || undefined}
                    alt={`${nftName} - NFT artwork`}
                    className={scopedClass?.('nft-image', 'ListingCard') || 'nft-image'}
                    seed={imageSeed}
                    width={300}
                    height={200}
                    metadata={listing?.metadata || {}}
                    key={`image-${nftContract}-${tokenId}`}
                />
            </div>

            <div className={scopedClass?.('listing-details', 'ListingCard') || 'listing-details'}>
                <div className={scopedClass?.('listing-info', 'ListingCard') || 'listing-info'}>
                    <h3 className={scopedClass?.('listing-title', 'ListingCard') || 'listing-title'}>{nftName}</h3>
                    <div className={`${scopedClass?.('listing-contract', 'ListingCard') || 'listing-contract'} ${scopedClass?.('small', 'ListingCard') || 'small'}`}>
                        {shortAddr(nftContract)}
                    </div>
                    {nftDescription && (
                        <p
                            id={`description-${safeStr(listing?.id)}`}
                            className={scopedClass?.('listing-description', 'ListingCard') || 'listing-description'}
                        >
                            {nftDescription}
                        </p>
                    )}
                </div>

                <div className={scopedClass?.('listing-price', 'ListingCard') || 'listing-price'} role="region" aria-label="Price information">
                    {priceDisplay.hasUSDCRate ? (
                        <>
                            <div className={scopedClass?.('price-amount', 'ListingCard') || 'price-amount'}>
                                ${priceDisplay.usdcValue}
                            </div>
                            <div className={scopedClass?.('price-currency', 'ListingCard') || 'price-currency'}>
                                USDC
                            </div>
                            {priceDisplay.tokenSymbol && priceDisplay.tokenSymbol !== 'USDC.pol' && (
                                <div className={scopedClass?.('price-original', 'ListingCard') || 'price-original'}>
                                    {priceDisplay.tokenAmount} {priceDisplay.tokenSymbol}
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            <div className={scopedClass?.('price-amount', 'ListingCard') || 'price-amount'}>
                                {priceDisplay.tokenAmount}
                            </div>
                            <div className={scopedClass?.('price-currency', 'ListingCard') || 'price-currency'}>
                                {priceDisplay.tokenSymbol}
                            </div>
                            <div className={scopedClass?.('price-note', 'ListingCard') || 'price-note'}>
                                No USDC rate available
                            </div>
                        </>
                    )}
                </div>

                {showSeller && (
                    <div className={`${scopedClass?.('listing-seller', 'ListingCard') || 'listing-seller'} ${scopedClass?.('small', 'ListingCard') || 'small'}`}>
                        Seller: {shortAddr(seller)}
                    </div>
                )}

                <div className={scopedClass?.('listing-actions', 'ListingCard') || 'listing-actions'}>
                    {isOwner ? (
                        <button
                            className={scopedClass?.('secondary-button', 'ListingCard') || 'secondary-button'}
                            disabled
                            aria-label="You own this NFT"
                        >
                            You own this
                        </button>
                    ) : (
                        <button
                            className={`${scopedClass?.('primary-button', 'ListingCard') || 'primary-button'} ${scopedClass?.('buy-button', 'ListingCard') || 'buy-button'}`}
                            onClick={handleBuy}
                            disabled={buying}
                            aria-label={`Buy ${nftName} for ${priceDisplay.formatted}`}
                            aria-describedby={`price-${safeStr(listing?.id)}`}
                        >
                            {buying ? 'Processing...' : 'Buy Now'}
                        </button>
                    )}
                </div>
            </div>

            <div id={`price-${safeStr(listing?.id)}`} className="sr-only">
                Price: {priceDisplay.formatted}
            </div>
        </article>
    );
}

function ListingCard(props) {
    return (
        <CardBoundary>
            <ListingCardInner {...props} />
        </CardBoundary>
    );
}

export default ListingCard;
