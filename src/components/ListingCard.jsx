import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useMarketplace } from '../context/MarketplaceContext';
import { useWallet } from '../context/WalletContext';
import { formatPriceWithUSDC, getTokenSymbol, fetchTokenDetails } from '../utils/tokenUtils';
import { resolveCollectionName, normalizeDescription, scopedClass } from '../utils/nftUtils';
import { debugWarn } from '../utils/debugUtils';
import './ListingCard.css';

/* =========================
   Error Boundary
   ========================= */
class CardBoundary extends React.Component {
    constructor(props) { super(props); this.state = { err: null }; }
    static getDerivedStateFromError(e) { return { err: e }; }
    componentDidCatch(e, info) { console.error('ListingCard error:', e, info); }
    render() {
        if (this.state.err) {
            return (
                <div style={{ padding: 12, border: '1px solid #d33', borderRadius: 8, background: 'rgba(255,0,0,0.08)', color: '#f44', fontSize: 14 }}>
                    <strong>Card crashed:</strong> {String(this.state.err?.message || this.state.err)}
                </div>
            );
        }
        return this.props.children;
    }
}

/* =========================
   Utilities (hash + svg fallback)
   ========================= */
const safeStr = (v, d = '') => (typeof v === 'string' ? v : d);
const shortAddr = (a) => (a && a.length > 9 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || '—'));
const hashString = (str) => { let h = 0; for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; } return Math.abs(h); };
const imageUrlCache = Object.create(null);

function svgFallbackDataUrl({ seed = 'nft', width = 300, height = 200, title = '' }) {
    const h = hashString(seed), hue = h % 360, hue2 = (hue + 180) % 360, gradId = `g${(h % 1e9).toString(36)}`, block = (h % 7) + 3;
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
        const a = (h + i * 97) % 360, r = 14 + ((h >> i) % 40);
        const cx = (width / (block + 1)) * (i + 1);
        const cy = (height / (block + 1)) * ((i % 3) + 1);
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsla(${a},70%,60%,0.25)"/>`;
    }).join('')}
    <text x="50%" y="${height - 14}" font-family="ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto" font-size="14" fill="rgba(255,255,255,0.9)" text-anchor="middle">${label}</text>
  </svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/* =========================
   Viewport hook (IO)
   ========================= */
function useInView(ref, { rootMargin = '200px', once = true } = {}) {
    const [inView, setInView] = useState(false);
    useEffect(() => {
        if (!ref.current || typeof IntersectionObserver === 'undefined') { setInView(true); return; }
        const io = new IntersectionObserver((entries) => {
            entries.forEach(e => {
                if (e.isIntersecting) { setInView(true); if (once) io.disconnect(); }
                else if (!once) { setInView(false); }
            });
        }, { rootMargin });
        io.observe(ref.current);
        return () => io.disconnect();
    }, [ref, rootMargin, once]);
    return inView;
}

/* =========================
   Robust IPFS/Arweave resolver
   ========================= */
const IPFS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipfs/', 'https://cf-ipfs.com/ipfs/', 'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/', 'https://infura-ipfs.io/ipfs/', 'https://w3s.link/ipfs/',
    'https://nftstorage.link/ipfs/', 'https://ipfs.io/ipfs/'
];
const IPNS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipns/', 'https://cf-ipfs.com/ipns/', 'https://dweb.link/ipns/',
    'https://gateway.pinata.cloud/ipns/', 'https://infura-ipfs.io/ipns/', 'https://w3s.link/ipns/',
    'https://nftstorage.link/ipns/', 'https://ipfs.io/ipns/'
];

function expandToCandidateUrls(raw) {
    if (!raw || typeof raw !== 'string') return [];
    const url = raw.trim();
    if (url.startsWith('data:')) return [url];
    if (url.startsWith('ar://')) return [`https://arweave.net/${url.slice(5)}`];
    if (/^https?:\/\/arweave\.net\//i.test(url)) return [url];

    if (url.startsWith('ipfs://')) {
        let rest = url.slice(7).replace(/^ipfs\//i, '');
        return IPFS_GATEWAYS.map(g => g + rest);
    }
    if (url.startsWith('ipns://')) {
        let rest = url.slice(7).replace(/^ipns\//i, '');
        return IPNS_GATEWAYS.map(g => g + rest);
    }
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const ipfsIdx = parts.indexOf('ipfs');
        const ipnsIdx = parts.indexOf('ipns');
        if (ipfsIdx !== -1 && parts[ipfsIdx + 1]) return IPFS_GATEWAYS.map(g => g + parts.slice(ipfsIdx + 1).join('/'));
        if (ipnsIdx !== -1 && parts[ipnsIdx + 1]) return IPNS_GATEWAYS.map(g => g + parts.slice(ipnsIdx + 1).join('/'));
        return [url];
    } catch {
        if (/^[a-z0-9]+$/i.test(url)) return IPFS_GATEWAYS.map(g => g + url);
        return [url];
    }
}

function findFirstWorkingImage(candidates, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        if (!candidates?.length) return reject(new Error('No candidates'));
        if (typeof window === 'undefined') return reject(new Error('SSR'));
        let settled = false, idx = 0;
        const tryNext = () => {
            if (settled) return;
            if (idx >= candidates.length) return reject(new Error('No gateway worked'));
            const url = candidates[idx++], img = new Image();
            const timer = setTimeout(() => { img.onload = null; img.onerror = null; tryNext(); }, timeoutMs);
            img.onload = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(url); };
            img.onerror = () => { clearTimeout(timer); tryNext(); };
            img.src = url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now();
        };
        tryNext();
    });
}

function collectImageSources(listing) {
    const m = listing?.metadata || {};
    const s = [
        m.image, listing?.image, listing?.imageUrl, m.image_url, m.imageUrl
    ];
    const seen = new Set();
    return s.filter(Boolean).map(x => String(x).trim()).filter(x => seen.has(x) ? false : (seen.add(x), true));
}
function collectAnimationSources(listing) {
    const m = listing?.metadata || {};
    const s = [m.animation_url, m.animationUrl];
    const seen = new Set();
    return s.filter(Boolean).map(x => String(x).trim()).filter(x => seen.has(x) ? false : (seen.add(x), true));
}

async function resolveWorkingMediaUrl(listing, { preferAnimation = false } = {}) {
    const cacheKey = `${safeStr(listing?.nftContract)}-${safeStr(listing?.tokenId)}-${preferAnimation ? 'anim' : 'img'}`;
    if (imageUrlCache[cacheKey]) return imageUrlCache[cacheKey];

    const base = preferAnimation ? [...collectAnimationSources(listing), ...collectImageSources(listing)]
        : [...collectImageSources(listing), ...collectAnimationSources(listing)];
    if (!base.length) return null;

    const candidates = [];
    const seen = new Set();
    for (const src of base) {
        for (const c of expandToCandidateUrls(src)) {
            if (!seen.has(c)) { seen.add(c); candidates.push(c); }
        }
    }
    try {
        const working = await findFirstWorkingImage(candidates);
        imageUrlCache[cacheKey] = working;
        return working;
    } catch (err) {
        debugWarn?.('No working gateway for media', err);
        return null;
    }
}

/* =========================
   Media component (img or video)
   ========================= */
function isVideoUrl(u) {
    return typeof u === 'string' && /\.(mp4|webm|ogg|gif)$/i.test(u); // play gif as <img>, mp4/webm/ogg as <video>
}

function AssetMedia({
    url,
    alt,
    seed,
    width = 300,
    height = 200,
    className,
    posterUrl,
    autoPlay = false
}) {
    const fallback = svgFallbackDataUrl({ seed, width, height, title: alt || '' });
    if (!url) {
        return <img src={fallback} alt={alt || ''} width={width} height={height} className={`${className || ''} lc-img`} loading="lazy" />;
    }
    if (isVideoUrl(url) && !/\.gif$/i.test(url)) {
        return (
            <video
                className={`${className || ''} lc-video`}
                width={width}
                height={height}
                playsInline
                muted
                loop
                autoPlay={autoPlay}
                preload="metadata"
                poster={posterUrl || undefined}
            >
                <source src={url} />
            </video>
        );
    }
    return (
        <img
            src={url}
            alt={alt || ''}
            width={width}
            height={height}
            className={`${className || ''} lc-img`}
            loading="lazy"
            onError={(e) => { e.currentTarget.src = fallback; }}
        />
    );
}

/* =========================
   Favorite (localStorage)
   ========================= */
function useFavorite(key) {
    const storageKey = `fav:${key}`;
    const [fav, setFav] = useState(() => localStorage.getItem(storageKey) === '1');
    const toggle = useCallback(() => {
        setFav(v => {
            const nv = !v;
            try { if (nv) localStorage.setItem(storageKey, '1'); else localStorage.removeItem(storageKey); } catch { }
            return nv;
        });
    }, [storageKey]);
    return [fav, toggle];
}

/* =========================
   Listing Card
   ========================= */
function ListingCardInner({
    listing,
    featured = false,
    showSeller = true,
    autoPlayAnimation = true,
    explorerBase // e.g., "https://explorer.vitruveo.com/address/"
}) {
    const { buyListing, status } = useMarketplace?.() || {};
    const { wallet, connect, provider } = useWallet?.() || {};

    const cardRef = useRef(null);
    const inView = useInView(cardRef, { rootMargin: '300px' });

    const [tokenSymbol, setTokenSymbol] = useState('TOKEN');
    const [priceDisplay, setPriceDisplay] = useState({ tokenAmount: '...', tokenSymbol: 'TOKEN', usdcValue: '0.00', formatted: '...', hasUSDCRate: true });
    const [mediaUrl, setMediaUrl] = useState(null);
    const [posterUrl, setPosterUrl] = useState(null);
    const [loadingMedia, setLoadingMedia] = useState(true);

    const seller = safeStr(listing?.seller);
    const isOwner = seller && wallet && safeStr(wallet).toLowerCase() === seller.toLowerCase();

    const nftContract = safeStr(listing?.nftContract);
    const tokenId = safeStr(listing?.tokenId);
    const seed = `${nftContract}${tokenId}`;
    const nftName = resolveCollectionName?.(listing || {}) || 'Untitled NFT';
    const nftDescription = normalizeDescription?.(safeStr(listing?.metadata?.description) || safeStr(listing?.description)) || '';

    /* Resolve media lazily when visible */
    useEffect(() => {
        let cancelled = false;
        if (!inView) { return; }
        (async () => {
            try {
                setLoadingMedia(true);
                const preferAnim = !!autoPlayAnimation;
                const url = await resolveWorkingMediaUrl(listing || {}, { preferAnimation: preferAnim });
                // If video, try to resolve a still image as poster too
                let poster = null;
                if (url && isVideoUrl(url)) {
                    const imgOnly = await resolveWorkingMediaUrl(listing || {}, { preferAnimation: false });
                    poster = imgOnly && !isVideoUrl(imgOnly) ? imgOnly : null;
                }
                if (!cancelled) { setMediaUrl(url); setPosterUrl(poster); setLoadingMedia(false); }
            } catch (e) {
                debugWarn?.('resolve media failed', e);
                if (!cancelled) { setMediaUrl(null); setPosterUrl(null); setLoadingMedia(false); }
            }
        })();
        return () => { cancelled = true; };
    }, [inView, listing, autoPlayAnimation]);

    /* Prefetch on hover (speeds perceived load) */
    const prefetchRef = useRef(false);
    const onHoverPrefetch = useCallback(() => {
        if (prefetchRef.current || mediaUrl) return;
        prefetchRef.current = true;
        resolveWorkingMediaUrl(listing || {}, { preferAnimation: !!autoPlayAnimation }).then(() => { }).catch(() => { });
    }, [listing, mediaUrl, autoPlayAnimation]);

    /* Price formatting */
    useEffect(() => {
        (async () => {
            if (!listing?.pricePerUnit || !listing?.paymentToken || !provider) return;
            try {
                const priceInfo = await formatPriceWithUSDC(listing.pricePerUnit, listing.paymentToken, provider, false);
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

    const handleBuy = async () => {
        if (!wallet) { await connect?.(); return; }
        if (!buyListing) return;
        if (!listing?.id || !listing?.pricePerUnit || !listing?.paymentToken) return;
        buyListing(listing.id, listing.pricePerUnit, listing.paymentToken);
    };

    /* Share / Favorite / Explorer */
    const detailUrl = useMemo(() => {
        const origin = typeof window !== 'undefined' ? window.location.origin : '';
        // Fallback deep link
        return `${origin}/marketplace?contract=${encodeURIComponent(nftContract)}&id=${encodeURIComponent(tokenId)}`;
    }, [nftContract, tokenId]);

    const [fav, toggleFav] = useFavorite(`${nftContract}:${tokenId}`);

    const onShare = async () => {
        const title = nftName;
        const text = `Check out ${nftName} #${tokenId}`;
        try {
            if (navigator.share) {
                await navigator.share({ title, text, url: detailUrl });
            } else {
                await navigator.clipboard?.writeText(detailUrl);
            }
        } catch { }
    };

    const explorerLink = explorerBase && nftContract ? `${explorerBase}${nftContract}` : undefined;

    return (
        <article
            ref={cardRef}
            className={`${scopedClass?.('listing-card', 'ListingCard') || 'listing-card'} ${featured ? (scopedClass?.('featured', 'ListingCard') || 'featured') : ''}`}
            role="article"
            aria-label={`NFT listing: ${nftName}`}
            onMouseEnter={onHoverPrefetch}
        >
            {/* Top chips */}
            <div className={scopedClass?.('lc-chips', 'ListingCard') || 'lc-chips'}>
                {featured && <span className="lc-chip lc-chip--hot">🔥 Featured</span>}
                {isOwner && <span className="lc-chip lc-chip--you">Yours</span>}
            </div>

            {/* Media */}
            <div className={`${scopedClass?.('listing-image', 'ListingCard') || 'listing-image'} ${loadingMedia ? 'lc-loading' : ''}`}>
                <AssetMedia
                    url={inView ? mediaUrl : null}
                    posterUrl={posterUrl || undefined}
                    alt={`${nftName} - NFT artwork`}
                    className={scopedClass?.('nft-image', 'ListingCard') || 'nft-image'}
                    seed={seed}
                    width={300}
                    height={200}
                    autoPlay={autoPlayAnimation}
                />
                {loadingMedia && <div className="lc-blur-placeholder" aria-hidden />}
            </div>

            {/* Details */}
            <div className={scopedClass?.('listing-details', 'ListingCard') || 'listing-details'}>
                <div className={scopedClass?.('listing-info', 'ListingCard') || 'listing-info'}>
                    <h3 className={scopedClass?.('listing-title', 'ListingCard') || 'listing-title'} title={nftName}>{nftName}</h3>
                    <div className={`${scopedClass?.('listing-contract', 'ListingCard') || 'listing-contract'} ${scopedClass?.('small', 'ListingCard') || 'small'}`}>
                        {shortAddr(nftContract)} {tokenId ? `· #${tokenId}` : ''}
                    </div>
                    {nftDescription && (
                        <p className={scopedClass?.('listing-description', 'ListingCard') || 'listing-description'}>
                            {nftDescription}
                        </p>
                    )}
                </div>

                {/* Price chip */}
                <div className={scopedClass?.('listing-price', 'ListingCard') || 'listing-price'} role="region" aria-label="Price information">
                    {priceDisplay.hasUSDCRate ? (
                        <>
                            <div className={scopedClass?.('price-amount', 'ListingCard') || 'price-amount'}>${priceDisplay.usdcValue}</div>
                            <div className={scopedClass?.('price-currency', 'ListingCard') || 'price-currency'}>USDC</div>
                            {priceDisplay.tokenSymbol && priceDisplay.tokenSymbol !== 'USDC.pol' && (
                                <div className={scopedClass?.('price-original', 'ListingCard') || 'price-original'}>
                                    {priceDisplay.tokenAmount} {priceDisplay.tokenSymbol}
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            <div className={scopedClass?.('price-amount', 'ListingCard') || 'price-amount'}>{priceDisplay.tokenAmount}</div>
                            <div className={scopedClass?.('price-currency', 'ListingCard') || 'price-currency'}>{priceDisplay.tokenSymbol}</div>
                            <div className={scopedClass?.('price-note', 'ListingCard') || 'price-note'}>No USDC rate</div>
                        </>
                    )}
                </div>

                {showSeller && (
                    <div className={`${scopedClass?.('listing-seller', 'ListingCard') || 'listing-seller'} ${scopedClass?.('small', 'ListingCard') || 'small'}`}>
                        Seller: {shortAddr(seller)}
                    </div>
                )}

                {/* Actions */}
                <div className={scopedClass?.('listing-actions', 'ListingCard') || 'listing-actions'}>
                    <div className="lc-actions-left">
                        <button
                            type="button"
                            className="lc-icon-btn"
                            aria-pressed={fav}
                            aria-label={fav ? 'Unfavorite' : 'Favorite'}
                            onClick={toggleFav}
                            title={fav ? 'Unfavorite' : 'Favorite'}
                        >
                            {fav ? '❤️' : '🤍'}
                        </button>
                        <button type="button" className="lc-icon-btn" onClick={onShare} aria-label="Share" title="Share">🔗</button>
                        {explorerLink && (
                            <a className="lc-icon-btn" href={explorerLink} target="_blank" rel="noreferrer" aria-label="View on explorer" title="View on explorer">🔍</a>
                        )}
                    </div>

                    {isOwner ? (
                        <button className={scopedClass?.('secondary-button', 'ListingCard') || 'secondary-button'} disabled aria-label="You own this NFT">
                            You own this
                        </button>
                    ) : (
                        <button
                            className={`${scopedClass?.('primary-button', 'ListingCard') || 'primary-button'} ${scopedClass?.('buy-button', 'ListingCard') || 'buy-button'}`}
                            onClick={handleBuy}
                            disabled={buying}
                            aria-label={`Buy ${nftName} for ${priceDisplay.formatted}`}
                        >
                            {buying ? 'Processing…' : 'Buy Now'}
                        </button>
                    )}
                </div>
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
