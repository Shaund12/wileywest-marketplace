import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { useSupabase } from '../context/SupabaseContext';
import { getSupportedTokens, formatTokenAmount } from '../utils/tokenRegistry';
import { fetchTokenPriceInUSDC } from '../utils/tokenUtils';
import VtruMarketplaceArtifact from '../abi/VTRUNFTMarketplace.json';
import './AuctionStyles.css';
import './SellPage.css';

/* =========================================================
   IPFS/IPNS/Arweave + SmartMedia (self-contained utilities)
   ========================================================= */
const IPFS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipfs/',
    'https://cf-ipfs.com/ipfs/',
    'https://dweb.link/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://infura-ipfs.io/ipfs/',
    'https://w3s.link/ipfs/',
    'https://nftstorage.link/ipfs/',
    'https://ipfs.io/ipfs/',
];

const IPNS_GATEWAYS = [
    'https://cloudflare-ipfs.com/ipns/',
    'https://cf-ipfs.com/ipns/',
    'https://dweb.link/ipns/',
    'https://gateway.pinata.cloud/ipns/',
    'https://infura-ipfs.io/ipns/',
    'https://w3s.link/ipns/',
    'https://nftstorage.link/ipns/',
    'https://ipfs.io/ipns/',
];

const isString = (v) => typeof v === 'string' && v.trim().length > 0;
const uniq = (arr) => Array.from(new Set(arr));
const flatten = (arrs) => arrs.reduce((a, b) => a.concat(b), []);
const isVideoUrl = (u) => isString(u) && /\.(mp4|webm|ogg|mov|m4v)(\?.*)?$/i.test(u);

function erc1155HexId(tokenId) {
    try {
        return BigInt(tokenId).toString(16).toLowerCase().padStart(64, '0');
    } catch {
        return String(tokenId).replace(/^0x/i, '').toLowerCase().padStart(64, '0');
    }
}

function expandToCandidateUrls(raw) {
    if (!isString(raw)) return [];
    const url = raw.trim();
    if (url.startsWith('data:')) return [url];

    // Arweave
    if (url.startsWith('ar://')) return [`https://arweave.net/${url.slice(5)}`];
    if (/^https?:\/\/arweave\.net\//i.test(url)) return [url];

    // ipfs://CID/... → try multiple gateways
    if (url.startsWith('ipfs://')) {
        const rest = url.slice(7).replace(/^ipfs\//i, '');
        return IPFS_GATEWAYS.map((g) => g + rest);
    }
    // ipns://name → try multiple gateways
    if (url.startsWith('ipns://')) {
        const rest = url.slice(7).replace(/^ipns\//i, '');
        return IPNS_GATEWAYS.map((g) => g + rest);
    }

    // http(s) with /ipfs/ or /ipns/
    try {
        const u = new URL(url);
        const parts = u.pathname.split('/').filter(Boolean);
        const ipfsIdx = parts.indexOf('ipfs');
        const ipnsIdx = parts.indexOf('ipns');
        if (ipfsIdx !== -1 && parts[ipfsIdx + 1]) {
            const rest = parts.slice(ipfsIdx + 1).join('/');
            return IPFS_GATEWAYS.map((g) => g + rest);
        }
        if (ipnsIdx !== -1 && parts[ipnsIdx + 1]) {
            const rest = parts.slice(ipnsIdx + 1).join('/');
            return IPNS_GATEWAYS.map((g) => g + rest);
        }
        return [url];
    } catch {
        // bare CID
        if (/^[a-z0-9]+$/i.test(url)) return IPFS_GATEWAYS.map((g) => g + url);
        return [url];
    }
}

function metadataCandidatesFromUri(uri, tokenId, is1155 = false) {
    if (!isString(uri)) return [];
    const base = expandToCandidateUrls(uri);
    if (is1155 && uri.includes('{id}')) {
        const id64 = erc1155HexId(tokenId);
        return base.map((u) => u.replace('{id}', id64));
    }
    return base;
}

async function fetchJsonFromCandidates(candidates, timeoutMs = 9000) {
    for (const url of candidates) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), timeoutMs);
            const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
            clearTimeout(t);
            if (!res.ok) continue;

            // Some gateways lie on content-type; be tolerant
            const text = await res.text();
            try {
                const json = JSON.parse(text);
                return { json, usedUrl: url };
            } catch {
                // not json, try next
            }
        } catch {
            // try next
        }
    }
    throw new Error('No working metadata URL found');
}

function findFirstWorkingImage(candidates, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
        if (!candidates?.length) return reject(new Error('No candidates'));
        if (typeof window === 'undefined') return reject(new Error('No window'));

        let i = 0;
        const tryNext = () => {
            if (i >= candidates.length) return reject(new Error('No working image'));
            const test = candidates[i++];
            const img = new Image();
            const timer = setTimeout(() => {
                img.onload = img.onerror = null;
                tryNext();
            }, timeoutMs);
            img.onload = () => {
                clearTimeout(timer);
                resolve(test);
            };
            img.onerror = () => {
                clearTimeout(timer);
                tryNext();
            };
            img.src = test + (test.includes('?') ? '&' : '?') + 'cb=' + Date.now();
        };
        tryNext();
    });
}

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

function svgFallbackDataUrl({ seed = 'media', width = 640, height = 460, title = 'NFT Preview' }) {
    const h = hashString(seed);
    const hue = h % 360;
    const hue2 = (hue + 180) % 360;
    const gid = `g${(h % 1e9).toString(36)}`;
    const blobs = (h % 7) + 3;
    const label = (title || '').slice(0, 28) || 'NFT Preview';
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},70%,18%)"/>
      <stop offset="100%" stop-color="hsl(${hue2},70%,16%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#${gid})"/>
  ${Array.from({ length: blobs }).map((_, i) => {
        const a = (h + i * 97) % 360;
        const r = 18 + ((h >> i) % 42);
        const cx = (width / (blobs + 1)) * (i + 1);
        const cy = (height / (blobs + 1)) * ((i % 3) + 1);
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsla(${a},70%,60%,0.25)"/>`;
    }).join('')}
  <text x="50%" y="${height - 18}" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto" font-size="16" fill="rgba(255,255,255,0.9)" text-anchor="middle">${label}</text>
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const smartUrlCache = new Map();
/** SmartMedia: pick working video (mp4/webm/…) or image; otherwise nice SVG fallback */
function SmartMedia({ srcList = [], alt = '', width = 640, height = 460, seed = 'media', title = '', className = '' }) {
    const [finalUrl, setFinalUrl] = useState(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const raws = srcList.filter(isString);
        const key = raws.join('|');
        if (!raws.length) {
            setFinalUrl(null);
            setFailed(true);
            return;
        }

        if (smartUrlCache.has(key)) {
            setFinalUrl(smartUrlCache.get(key));
            setFailed(false);
            return;
        }

        const candidates = uniq(flatten(raws.map(expandToCandidateUrls)));
        // Prefer video if the URL clearly indicates one
        const videoCandidate = candidates.find(isVideoUrl);
        if (videoCandidate) {
            smartUrlCache.set(key, videoCandidate);
            if (!cancelled) {
                setFinalUrl(videoCandidate);
                setFailed(false);
            }
            return;
        }

        findFirstWorkingImage(candidates)
            .then((u) => {
                if (cancelled) return;
                smartUrlCache.set(key, u);
                setFinalUrl(u);
                setFailed(false);
            })
            .catch(() => {
                if (!cancelled) {
                    setFinalUrl(null);
                    setFailed(true);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [JSON.stringify(srcList)]);

    const fallback = svgFallbackDataUrl({ seed, width, height, title });
    const url = failed || !finalUrl ? fallback : finalUrl;

    if (isVideoUrl(url)) {
        return (
            <video
                src={url}
                controls
                className={className}
                width={width}
                height={height}
                style={{ display: 'block', borderRadius: 12, background: '#111', maxWidth: '100%', objectFit: 'cover' }}
            />
        );
    }
    return (
        <img
            src={url}
            alt={alt}
            className={className}
            width={width}
            height={height}
            loading="lazy"
            onError={() => setFailed(true)}
            style={{ display: 'block', borderRadius: 12, maxWidth: '100%', objectFit: 'cover' }}
        />
    );
}

/* =========================================================
   ABIs / Token addresses / Uniswap config
   ========================================================= */
const ERC721_ABI = [
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
];

const ERC1155_ABI = [
    'function uri(uint256 id) view returns (string)',
    'function balanceOf(address account, uint256 id) view returns (uint256)',
];

const UNISWAP_V3_FACTORY_ABI = [
    'function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)',
];

const UNISWAP_V3_POOL_ABI = [
    'function token0() external view returns (address)',
    'function token1() external view returns (address)',
    'function fee() external view returns (uint24)',
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function balanceOf(address owner) view returns (uint256)',
];

const ERC721_APPROVAL_ABI = [
    'function setApprovalForAll(address operator, bool approved) returns ()',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function approve(address to, uint256 tokenId) returns ()',
    'function getApproved(uint256 tokenId) view returns (address)',
];

const ERC1155_APPROVAL_ABI = [
    'function setApprovalForAll(address operator, bool approved) returns ()',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
];

// Token addresses (Vitruveo chain)
const WVTRU_ADDRESS = '0x3ccc3F22462cAe34766820894D04a40381201ef9';
const USDC_ADDRESS = '0xbCfB3FCa16b12C7756CD6C24f1cC0AC0E38569CF';
const VUSD_ADDRESS = '0x1D607d8c617A09c638309bE2Ceb9b4afF42236dA';
const SEVO_ADDRESS = '0x2A34059DF3D60B1864f10F10492746bd26d3D24a';
const WSEVO_ADDRESS = '0x43a36604B6Ad9A4cf8EF600241E90b3DD97E145d';
const VITEX_ADDRESS = '0x4Ed92A1d95d2092973007197794542A5D51FF5a6';
const VTRO_ADDRESS = '0xDECAF2f187Cb837a42D26FA364349Abc3e80Aa5D';

// Uniswap V3 (Vitruveo)
const UNISWAP_V3_FACTORY_ADDRESS = '0x6196a7a6108B15a2cc24DdaB41C8CC3098C06351';
const FEE_TIERS = [500, 3000, 10000];

/* =========================================================
   Component
   ========================================================= */
function CreateAuctionPage() {
    const navigate = useNavigate();
    const { wallet, connect, provider, signer, isCorrectNetwork } = useWallet();
    const { status, setStatus, marketplaceAddress } = useMarketplace();
    const { cacheAuctions } = useSupabase();
    const [searchParams] = useSearchParams();

    const [formData, setFormData] = useState({
        nftContract: searchParams.get('contract') || '',
        tokenId: searchParams.get('tokenId') || '',
        quantity: '1',
        reservePrice: '',
        startPrice: '',
        duration: '24', // hours
        paymentToken: ethers.ZeroAddress,
        minBidIncrementBps: '500', // 5%
        antiSnipeSeconds: '600', // 10 minutes
    });

    const [metadata, setMetadata] = useState(null);
    const [nftImage, setNftImage] = useState('');
    const [nftName, setNftName] = useState('');
    const [nftType, setNftType] = useState(null);
    const [balance, setBalance] = useState('0');
    const [loading, setLoading] = useState(false);
    const [ownershipVerified, setOwnershipVerified] = useState(false);
    const [auctionSuccess, setAuctionSuccess] = useState(false);

    // Token system state  
    const [startPriceUSD, setStartPriceUSD] = useState('0.00');
    const [reservePriceUSD, setReservePriceUSD] = useState('0.00');
    const [tokenList, setTokenList] = useState({});
    the
    const [paymentOptions, setPaymentOptions] = useState([]);
    const [loadingPrices, setLoadingPrices] = useState(false);
    const [showAddTokenForm, setShowAddTokenForm] = useState(false);
    const [customTokenData, setCustomTokenData] = useState({ address: '', symbol: '', name: '', decimals: '18', price: '' });
    const [customTokenError, setCustomTokenError] = useState('');

    const [livePrice, setLivePrice] = useState({});
    const [priceChange, setPriceChange] = useState({});
    const [lastUpdateTime, setLastUpdateTime] = useState(null);
    const [priceSources, setPriceSources] = useState({});
    const [priceErrors, setPriceErrors] = useState({});

    const priceIntervalRef = useRef(null);

    // Set document title
    useEffect(() => {
        document.title = 'Create Auction • BlockDust';
    }, []);

    // Helper function to calculate USD value for a given amount and token
    const calculateUSDValue = (amount, tokenAddress) => {
        if (!amount || isNaN(parseFloat(amount)) || !tokenAddress) return '0.00';

        // For native VTRU (ZeroAddress), use WVTRU price lookup
        const priceKey = tokenAddress === ethers.ZeroAddress ? WVTRU_ADDRESS : tokenAddress;
        const currentPrice = livePrice[priceKey];

        if (!currentPrice || typeof currentPrice !== 'number') return 'Unknown';

        if (tokenAddress === USDC_ADDRESS || tokenAddress === 'USDC') {
            return parseFloat(amount).toFixed(2);
        } else {
            return (parseFloat(amount) * currentPrice).toFixed(2);
        }
    };

    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));

        // Update USD calculations for price fields
        if (name === 'reservePrice') {
            setReservePriceUSD(calculateUSDValue(value, formData.paymentToken));
        } else if (name === 'startPrice') {
            setStartPriceUSD(calculateUSDValue(value, formData.paymentToken));
        }
    };

    // Change payment token => recompute both USD values
    const handlePaymentTokenChange = (e) => {
        const tokenAddress = e.target.value;
        setFormData(prev => ({ ...prev, paymentToken: tokenAddress }));

        // Recalculate USD values for both fields
        setStartPriceUSD(calculateUSDValue(formData.startPrice, tokenAddress));
        setReservePriceUSD(calculateUSDValue(formData.reservePrice, tokenAddress));
    };

    const formatTime = (date) => (date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

    // Cleanup
    useEffect(() => {
        return () => {
            if (priceIntervalRef.current) clearInterval(priceIntervalRef.current);
        };
    }, []);

    /* =========================
       Token init + price fetching
       ========================= */
    useEffect(() => {
        if (!provider) return;
        const init = async () => {
            const initialized = await initializeTokens();
            await fetchUniswapPrices(0, initialized);
        };
        init().catch((err) => {
            console.error(err);
            setStatus('Error initializing tokens. Please refresh the page.');
        });
    }, [provider]);

    const getUniswapPool = async (tokenA, tokenB) => {
        try {
            const factory = new ethers.Contract(UNISWAP_V3_FACTORY_ADDRESS, UNISWAP_V3_FACTORY_ABI, provider);
            for (const fee of FEE_TIERS) {
                try {
                    const poolAddress = await factory.getPool(tokenA, tokenB, fee);
                    if (poolAddress && poolAddress !== ethers.ZeroAddress) return { poolAddress, fee };
                } catch { }
            }
            return { poolAddress: null, fee: null };
        } catch {
            return { poolAddress: null, fee: null };
        }
    };

    const getUniswapPrice = async (tokenAddress) => {
        const price = await fetchTokenPriceInUSDC(tokenAddress, provider);
        const tokenSymbol = tokenList[tokenAddress]?.symbol || 'Unknown';
        let source;
        if (tokenAddress === ethers.ZeroAddress) source = 'Uniswap V3 (WVTRU proxy)';
        else if (tokenAddress === USDC_ADDRESS) source = 'USD Stablecoin';
        else source = `Uniswap V3 (${tokenSymbol}/USDC)`;
        return { price, source };
    };

    const fetchUniswapPrices = async (retryCount = 0, providedTokenList = null) => {
        const MAX_RETRIES = 3;
        const RETRY_DELAY = 2000;
        const activeTokenList = providedTokenList || tokenList;
        if (!activeTokenList || Object.keys(activeTokenList).length === 0) return;

        try {
            const previousPrices = { ...livePrice };
            const newPrices = {};
            const changes = {};
            const newSources = { ...priceSources };
            const errors = {};

            newPrices[USDC_ADDRESS] = 1.0;
            newSources[USDC_ADDRESS] = 'USD Stablecoin';
            changes[USDC_ADDRESS] = 0;

            const entries = Object.entries(activeTokenList);

            // WVTRU first
            const wv = entries.find(([a]) => a === WVTRU_ADDRESS);
            if (wv) {
                const [address] = wv;
                try {
                    const { price, source } = await getUniswapPrice(address);
                    if (price && price > 0) {
                        newPrices[address] = price;
                        newSources[address] = source;
                        changes[address] = previousPrices[address] ? ((price - previousPrices[address]) / previousPrices[address]) * 100 : 0;
                    } else throw new Error('Invalid price');
                } catch (e) {
                    errors[address] = e.message || 'Unknown error';
                    if (previousPrices[address]) {
                        newPrices[address] = previousPrices[address];
                        changes[address] = 0;
                        newSources[address] = 'Outdated (fetch failed)';
                    } else {
                        newPrices[address] = null;
                        newSources[address] = 'No price data';
                    }
                }
            }

            // Others
            for (const [address] of entries) {
                if (address === USDC_ADDRESS || address === WVTRU_ADDRESS) continue;
                try {
                    const { price, source } = await getUniswapPrice(address);
                    if (price && price > 0) {
                        newPrices[address] = price;
                        newSources[address] = source;
                        changes[address] = previousPrices[address] ? ((price - previousPrices[address]) / previousPrices[address]) * 100 : 0;
                    } else throw new Error('Invalid price');
                } catch (e) {
                    errors[address] = e.message || 'Unknown error';
                    if (previousPrices[address]) {
                        newPrices[address] = previousPrices[address];
                        changes[address] = 0;
                        newSources[address] = 'Outdated (fetch failed)';
                    } else {
                        newPrices[address] = null;
                        newSources[address] = 'No price data';
                    }
                }
                await new Promise((r) => setTimeout(r, 100));
            }

            const validated = {};
            Object.entries(newPrices).forEach(([a, p]) => {
                validated[a] = typeof p === 'number' && p >= 0 ? p : null;
            });

            setLivePrice(validated);
            setPriceChange(changes);
            setPriceSources(newSources);
            setPriceErrors(errors);
            setLastUpdateTime(new Date());

            // Update USD displays rather than using an undefined setDisplayPrice
            setStartPriceUSD(calculateUSDValue(formData.startPrice, formData.paymentToken));
            setReservePriceUSD(calculateUSDValue(formData.reservePrice, formData.paymentToken));
        } catch (error) {
            if (retryCount < MAX_RETRIES && /(network|timeout|fetch)/i.test(error.message || '')) {
                setTimeout(() => fetchUniswapPrices(retryCount + 1, activeTokenList), RETRY_DELAY);
            } else {
                setStatus('Warning: Some token prices could not be fetched. You can still create auctions.');
            }
        }
    };

    const initializeTokens = async () => {
        setLoadingPrices(true);
        const initialTokens = {};
        try {
            initialTokens[ethers.ZeroAddress] = {
                address: ethers.ZeroAddress,
                symbol: 'VTRU',
                name: 'Native VTRU',
                decimals: 18,
                isNative: true,
            };

            // WVTRU
            try {
                const c = new ethers.Contract(WVTRU_ADDRESS, ERC20_ABI, provider);
                const [symbol, name, decimals] = await Promise.all([
                    c.symbol().catch(() => 'WVTRU'),
                    c.name().catch(() => 'Wrapped VTRU'),
                    c.decimals().catch(() => 18),
                ]);
                initialTokens[WVTRU_ADDRESS] = { address: WVTRU_ADDRESS, symbol, name, decimals };
            } catch {
                initialTokens[WVTRU_ADDRESS] = { address: WVTRU_ADDRESS, symbol: 'WVTRU', name: 'Wrapped VTRU', decimals: 18 };
            }

            // USDC
            try {
                const c = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
                const [symbol, name, decimals] = await Promise.all([
                    c.symbol().catch(() => 'USDC'),
                    c.name().catch(() => 'USD Coin'),
                    c.decimals().catch(() => 6),
                ]);
                initialTokens[USDC_ADDRESS] = { address: USDC_ADDRESS, symbol, name, decimals };
            } catch {
                initialTokens[USDC_ADDRESS] = { address: USDC_ADDRESS, symbol: 'USDC', name: 'USD Coin', decimals: 6 };
            }

            const addToken = async (addr, fallbackSymbol, fallbackName, fallbackDecimals = 18) => {
                try {
                    const c = new ethers.Contract(addr, ERC20_ABI, provider);
                    const [symbol, name, decimals] = await Promise.all([
                        c.symbol().catch(() => fallbackSymbol),
                        c.name().catch(() => fallbackName),
                        c.decimals().catch(() => fallbackDecimals),
                    ]);
                    initialTokens[addr] = { address: addr, symbol, name, decimals };
                } catch {
                    initialTokens[addr] = { address: addr, symbol: fallbackSymbol, name: fallbackName, decimals: fallbackDecimals };
                }
            };

            await addToken(VUSD_ADDRESS, 'VUSD', 'VUSD Token');
            await addToken(SEVO_ADDRESS, 'SEVO', 'SEVO Token');
            await addToken(WSEVO_ADDRESS, 'WSEVO', 'Wrapped SEVO');
            await addToken(VITEX_ADDRESS, 'VITEX', 'VITEX Token');
            await addToken(VTRO_ADDRESS, 'VTRO', 'VTRO Token');

            setTokenList(initialTokens);
            setLastUpdateTime(new Date());

            const options = Object.entries(initialTokens).map(([address, token]) => ({
                address,
                name: `${token.symbol}${token.isNative ? ' (Native)' : ''}`,
                fullName: token.name,
                symbol: token.symbol,
                price: address === USDC_ADDRESS ? 1.0 : null,
                priceSource: address === USDC_ADDRESS ? 'USD Stablecoin' : 'Price pending...',
                error: null,
            }));
            setPaymentOptions(options);

            return initialTokens;
        } catch (error) {
            setStatus('Error loading token information. Please refresh the page.');
            throw error;
        } finally {
            setLoadingPrices(false);
        }
    };

    const buildPaymentOptions = () => {
        if (!tokenList || Object.keys(tokenList).length === 0) {
            setPaymentOptions([]);
            return;
        }
        const options = Object.entries(tokenList).map(([address, token]) => {
            // For native VTRU, get price from WVTRU address
            const priceKey = address === ethers.ZeroAddress ? WVTRU_ADDRESS : address;
            const price = livePrice[priceKey];
            const priceSource = priceSources[priceKey] || 'Unknown';
            const error = priceErrors[priceKey];
            const validPrice = typeof price === 'number' && price > 0 ? price : null;
            return {
                address,
                name: `${token.symbol}${token.isNative ? ' (Native)' : ''}`,
                fullName: token.name,
                symbol: token.symbol,
                price: validPrice,
                priceSource,
                error,
            };
        });
        setPaymentOptions(options);
    };

    useEffect(() => {
        if (Object.keys(tokenList).length > 0) buildPaymentOptions();
    }, [tokenList, livePrice, priceSources, priceErrors]);

    // Update USD values when prices change or payment token changes
    useEffect(() => {
        if (formData.paymentToken) {
            // For native VTRU, check WVTRU price; otherwise use the token's own price
            const priceKey = formData.paymentToken === ethers.ZeroAddress ? WVTRU_ADDRESS : formData.paymentToken;
            if (livePrice[priceKey]) {
                setStartPriceUSD(calculateUSDValue(formData.startPrice, formData.paymentToken));
                setReservePriceUSD(calculateUSDValue(formData.reservePrice, formData.paymentToken));
            }
        }
    }, [livePrice, formData.paymentToken, formData.startPrice, formData.reservePrice]);

    const handleCustomTokenChange = (e) => {
        const { id, value } = e.target;
        setCustomTokenData({ ...customTokenData, [id]: value });
    };

    const addCustomToken = async () => {
        setCustomTokenError('');

        if (!ethers.isAddress(customTokenData.address)) {
            setCustomTokenError('Invalid address format');
            return;
        }

        try {
            const checksum = ethers.getAddress(customTokenData.address);
            if (tokenList[checksum]) {
                setCustomTokenError('Token already added');
                return;
            }

            setLoadingPrices(true);
            const c = new ethers.Contract(checksum, ERC20_ABI, provider);

            let symbol, name, decimals;
            try {
                symbol = await c.symbol();
                name = await c.name();
                decimals = await c.decimals();
            } catch {
                symbol = customTokenData.symbol || 'UNKNOWN';
                name = customTokenData.name || 'Custom Token';
                decimals = parseInt(customTokenData.decimals) || 18;
            }

            const newToken = { address: checksum, symbol, name, decimals };
            setTokenList((prev) => ({ ...prev, [checksum]: newToken }));

            if (customTokenData.price) {
                const manual = parseFloat(customTokenData.price);
                setLivePrice((prev) => ({ ...prev, [checksum]: manual }));
                setPriceSources((prev) => ({ ...prev, [checksum]: 'Manually entered' }));
            } else {
                setPriceSources((prev) => ({ ...prev, [checksum]: 'Fetching from Uniswap...' }));
            }

            setCustomTokenData({ address: '', symbol: '', name: '', decimals: '18', price: '' });
            setShowAddTokenForm(false);
        } catch (error) {
            setCustomTokenError(`Error adding token: ${error.message}`);
        } finally {
            setLoadingPrices(false);
        }
    };

    // Decode custom errors and reasons
    const decodeRevert = (err) => {
        try {
            const data = err?.data || err?.error?.data;
            if (data) {
                const iface = new ethers.Interface(VtruMarketplaceArtifact.abi);
                const parsed = iface.parseError(data);
                if (parsed?.name) return parsed.name + (parsed.args?.length ? `(${parsed.args.map(a => String(a)).join(',')})` : '');
            }
        } catch { /* ignore */ }
        const m = err?.reason || err?.message || String(err || '');
        return m.replace(/execution reverted:?/i, '').trim() || 'Transaction reverted';
    };

    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!wallet) {
            await connect();
            return;
        }
        if (!isCorrectNetwork) {
            setStatus('Error: Wrong network. Please switch to Vitruveo.');
            return;
        }
        if (!ownershipVerified) {
            setStatus('Error: Ownership not verified. You must own this NFT to create an auction.');
            return;
        }

        try {
            if (!signer) {
                setStatus("Error: Wallet not connected. Please connect your wallet first");
                return;
            }

            if (!marketplaceAddress || marketplaceAddress === ethers.ZeroAddress) {
                throw new Error("Marketplace contract not initialized");
            }

            setStatus('Preparing auction...');

            // Validate form data
            if (!formData.reservePrice || parseFloat(formData.reservePrice) <= 0) {
                setStatus('Error: Reserve price must be greater than 0');
                return;
            }
            if (!formData.startPrice || parseFloat(formData.startPrice) <= 0) {
                setStatus('Error: Starting price must be greater than 0');
                return;
            }

            const token = tokenList[formData.paymentToken];
            if (!token) {
                setStatus('Error: Please select a valid payment token');
                return;
            }

            // Convert prices to wei using token decimals
            const reservePriceInWei = ethers.parseUnits(formData.reservePrice, token.decimals || 18);
            const startPriceInWei = ethers.parseUnits(formData.startPrice, token.decimals || 18);

            // Compute start and end times
            const startTimeSec = Math.floor(Date.now() / 1000);
            const endTimeSec = startTimeSec + (parseInt(formData.duration) * 3600);

            // Check if this is an ERC721 or ERC1155
            let isERC1155 = false;
            try {
                const testContract = new ethers.Contract(
                    formData.nftContract,
                    ['function balanceOf(address, uint256) view returns (uint256)'],
                    provider
                );
                await testContract.balanceOf(wallet, formData.tokenId);
                isERC1155 = true;
            } catch {
                isERC1155 = false;
            }

            // Check and request NFT approval
            if (isERC1155) {
                const nftContract1155 = new ethers.Contract(formData.nftContract, ERC1155_APPROVAL_ABI, signer);
                const isApproved = await nftContract1155.isApprovedForAll(wallet, marketplaceAddress);

                if (!isApproved) {
                    setStatus("Requesting approval to auction your NFTs...");
                    const approvalTx = await nftContract1155.setApprovalForAll(marketplaceAddress, true);
                    setStatus("Approval transaction submitted. Please wait for confirmation...");
                    await approvalTx.wait();
                    setStatus("Approval confirmed! Creating auction...");
                }
            } else {
                const nftContract721 = new ethers.Contract(formData.nftContract, ERC721_APPROVAL_ABI, signer);
                const isApprovedForAll = await nftContract721.isApprovedForAll(wallet, marketplaceAddress);

                if (!isApprovedForAll) {
                    const approvedAddress = await nftContract721.getApproved(formData.tokenId);
                    const isTokenApproved = String(approvedAddress || '').toLowerCase() === String(marketplaceAddress || '').toLowerCase();

                    if (!isTokenApproved) {
                        setStatus("Requesting approval to auction your NFT...");
                        const approvalTx = await nftContract721.setApprovalForAll(marketplaceAddress, true);
                        setStatus("Approval transaction submitted. Please wait for confirmation...");
                        await approvalTx.wait();
                        setStatus("Approval confirmed! Creating auction...");
                    }
                }
            }

            // Create marketplace contract instance
            const contract = new ethers.Contract(marketplaceAddress, VtruMarketplaceArtifact.abi, signer);

            setStatus("Creating auction...");

            // Expected ABI (commonly):
            // createAuction(
            //  address nftContract,
            //  uint256 tokenId,
            //  uint256 quantity,
            //  bool isERC1155,
            //  address paymentToken,
            //  uint256 reservePrice,
            //  uint256 startPrice,
            //  uint64 startTime,
            //  uint64 endTime,
            //  uint32 minIncrementBps,
            //  uint32 antiSnipeWindow
            // )
            const args = [
                ethers.getAddress(formData.nftContract),
                BigInt(formData.tokenId),
                BigInt(formData.quantity || '1'),
                Boolean(isERC1155),
                ethers.getAddress(formData.paymentToken),
                reservePriceInWei,
                startPriceInWei,
                BigInt(startTimeSec),
                BigInt(endTimeSec),
                BigInt(parseInt(formData.minBidIncrementBps || '500', 10)),
                BigInt(parseInt(formData.antiSnipeSeconds || '600', 10)),
            ];

            // Preflight simulate
            await contract.createAuction.staticCall(...args).catch((e) => {
                throw new Error(decodeRevert(e));
            });

            // Estimate gas with buffer and set fees
            const overrides = {};
            try {
                const gas = await contract.createAuction.estimateGas(...args);
                overrides.gasLimit = (gas * 12n) / 10n; // +20%
            } catch {
                overrides.gasLimit = 1_200_000n; // fallback
            }
            try {
                const fee = await provider.getFeeData();
                if (fee?.maxFeePerGas) {
                    overrides.maxFeePerGas = fee.maxFeePerGas;
                    overrides.maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? 0n;
                } else if (fee?.gasPrice) {
                    overrides.gasPrice = fee.gasPrice;
                }
            } catch { /* ignore */ }

            const tx = await contract.createAuction(...args, overrides);
            setStatus("Transaction submitted. Waiting for confirmation...");
            const receipt = await tx.wait();
            setStatus("Auction created successfully!");

            // Extract auction ID from logs
            try {
                const iface = new ethers.Interface(VtruMarketplaceArtifact.abi);
                const auctionCreatedEvent = receipt.logs
                    .map(log => { try { return iface.parseLog(log); } catch { return null; } })
                    .find(event => event && event.name === 'AuctionCreated');

                if (auctionCreatedEvent) {
                    const auctionId = auctionCreatedEvent.args.auctionId?.toString();
                    if (auctionId) {
                        const auctionData = {
                            id: auctionId,
                            seller: wallet,
                            nftContract: ethers.getAddress(formData.nftContract),
                            tokenId: String(formData.tokenId),
                            quantity: String(formData.quantity),
                            reservePrice: reservePriceInWei.toString(),
                            startPrice: startPriceInWei.toString(),
                            startTime: startTimeSec,
                            endTime: endTimeSec,
                            paymentToken: ethers.getAddress(formData.paymentToken),
                            minBidIncrementBps: parseInt(formData.minBidIncrementBps, 10),
                            antiSnipeSeconds: parseInt(formData.antiSnipeSeconds, 10),
                            isERC1155: Boolean(isERC1155),
                            highestBid: '0',
                            highestBidder: '0x0000000000000000000000000000000000000000',
                            settled: false,
                            transactionHash: receipt.hash,
                            blockNumber: receipt.blockNumber,
                            logIndex: 0,
                            timestamp: Math.floor(Date.now() / 1000),
                            metadata: metadata || {}
                        };

                        await cacheAuctions([auctionData], marketplaceAddress);
                        setStatus("Auction created and cached successfully!");
                    }
                }
            } catch (error) {
                console.warn('Warning: Could not cache auction data:', error);
            }

            // Show success animation then redirect
            setAuctionSuccess(true);
            setTimeout(() => {
                setAuctionSuccess(false);
                navigate('/my-auctions');
            }, 2500);

        } catch (error) {
            const reason = decodeRevert(error);
            setStatus(`Error: ${reason}`);
        }
    };

    /* =========================
       NFT metadata (robust)
       ========================= */
    function mediaCandidatesFromMetadata(m) {
        if (!m || typeof m !== 'object') return [];
        return [m.image, m.image_url, m.imageUrl, m.animation_url, m.animationUrl].filter(isString);
    }

    const fetchNftMetadata = async () => {
        if (!formData.nftContract || !formData.tokenId) {
            setStatus('Please enter contract address and token ID');
            return;
        }
        if (!wallet) {
            setStatus('Please connect your wallet first');
            return;
        }
        if (!provider) {
            setStatus('No provider available. Please reconnect your wallet.');
            return;
        }

        setLoading(true);
        setStatus('Fetching NFT metadata...');
        setMetadata(null);
        setNftImage('');
        setNftName('');
        setOwnershipVerified(false);

        try {
            if (!ethers.isAddress(formData.nftContract)) throw new Error('Invalid contract address format');
            const checksum = ethers.getAddress(formData.nftContract);

            // Try ERC721 first
            try {
                const erc721 = new ethers.Contract(checksum, ERC721_ABI, provider);

                const owner = await erc721.ownerOf(formData.tokenId);
                const isOwner = owner?.toLowerCase?.() === wallet?.toLowerCase?.();
                setOwnershipVerified(!!isOwner);
                if (!isOwner) {
                    setStatus('Warning: You are not the owner of this NFT');
                    setLoading(false);
                    return;
                }

                const tokenURI = await erc721.tokenURI(formData.tokenId);
                const metaCands = metadataCandidatesFromUri(tokenURI, formData.tokenId, false);
                const { json } = await fetchJsonFromCandidates(metaCands);

                setMetadata(json);
                setNftName(json?.name || `NFT #${formData.tokenId}`);

                // Pre-resolve one working preview URL for zoom
                try {
                    const media = uniq(flatten(mediaCandidatesFromMetadata(json).map(expandToCandidateUrls)));
                    const firstVideo = media.find(isVideoUrl);
                    if (firstVideo) setNftImage(firstVideo);
                    else setNftImage(await findFirstWorkingImage(media));
                } catch {
                    setNftImage('');
                }

                setNftType('ERC721');
                setBalance('1');
                setStatus('');
                return;
            } catch {
                // fallthrough to ERC1155
            }

            // Try ERC1155
            try {
                const erc1155 = new ethers.Contract(checksum, ERC1155_ABI, provider);

                const bal = await erc1155.balanceOf(wallet, formData.tokenId);
                const ownerBalance = bal.toString();
                setBalance(ownerBalance);
                if (ownerBalance === '0') {
                    setStatus('Warning: You do not own any of these tokens');
                    setLoading(false);
                    return;
                }
                setOwnershipVerified(true);

                const uri = await erc1155.uri(formData.tokenId);
                const metaCands = metadataCandidatesFromUri(uri, formData.tokenId, true);
                const { json } = await fetchJsonFromCandidates(metaCands);

                setMetadata(json);
                setNftName(json?.name || `NFT #${formData.tokenId}`);

                try {
                    const media = uniq(flatten(mediaCandidatesFromMetadata(json).map(expandToCandidateUrls)));
                    const firstVideo = media.find(isVideoUrl);
                    if (firstVideo) setNftImage(firstVideo);
                    else setNftImage(await findFirstWorkingImage(media));
                } catch {
                    setNftImage('');
                }

                setNftType('ERC1155');
                setFormData((prev) => ({ ...prev, quantity: ownerBalance }));
                setStatus('');
            } catch {
                setStatus('Could not fetch NFT metadata. Make sure the contract and token ID are correct.');
            }
        } catch (error) {
            setStatus('Error fetching NFT metadata: ' + (error.message || error));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (formData.nftContract && formData.tokenId && wallet && provider) {
            fetchNftMetadata();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [formData.nftContract, formData.tokenId, wallet, provider]);

    /* =========================
       Rarity helpers
       ========================= */
    const getTraitRarity = (trait) => {
        const map = {
            common: { label: 'Common', color: '#78909c', percentage: '25.4%' },
            uncommon: { label: 'Uncommon', color: '#26a69a', percentage: '15.2%' },
            rare: { label: 'Rare', color: '#5c6bc0', percentage: '8.7%' },
            epic: { label: 'Epic', color: '#ab47bc', percentage: '3.2%' },
            legendary: { label: 'Legendary', color: '#ffb300', percentage: '0.9%' },
        };
        const keys = Object.keys(map);
        const i = Math.floor((((trait.trait_type?.length) || 0) + (String(trait.value || '').length)) % 5);
        return map[keys[i]];
    };

    if (!wallet) {
        return (
            <div className="hp" style={{ maxWidth: 800, margin: '3rem auto', padding: '0 1.25rem' }}>
                <div className="hp-section__head">
                    <h2>Create Auction</h2>
                    <p>Connect your wallet to create an auction</p>
                </div>
                <button onClick={connect} className="hp-btn hp-btn--primary">
                    Connect Wallet
                </button>
            </div>
        );
    }

    return (
        <div className="sell-container">
            <div className="page-header">
                <h1>Create Auction</h1>
                <p>Set up a timed auction for your NFT</p>
            </div>

            {/* Price Ticker with Uniswap Price Data */}
            {Object.keys(livePrice).length > 0 && (
                <div className="price-ticker">
                    <div className="ticker-header">
                        <span>Uniswap V3 Token Prices</span>
                        <span className="ticker-time">Last updated: {formatTime(lastUpdateTime)}</span>
                    </div>
                    <div className="ticker-items">
                        {Object.entries(tokenList)
                            .filter(([address]) => {
                                const priceKey = address === ethers.ZeroAddress ? WVTRU_ADDRESS : address;
                                return livePrice[priceKey] !== null;
                            })
                            .map(([address, token]) => {
                                const priceKey = address === ethers.ZeroAddress ? WVTRU_ADDRESS : address;
                                const price = livePrice[priceKey];
                                const change = priceChange[priceKey] || 0;
                                const source = priceSources[priceKey];
                                const error = priceErrors[priceKey];

                                return (
                                    <div className={`ticker-item ${error ? 'has-error' : ''}`} key={address}>
                                        <div className="ticker-symbol">{token.symbol}</div>
                                        {price ? (
                                            <>
                                                <div className="ticker-price">${price.toFixed(4)}</div>
                                                <div className={`ticker-change ${change > 0 ? 'positive' : change < 0 ? 'negative' : ''}`}>
                                                    {change > 0 ? '+' : ''}
                                                    {change.toFixed(2)}%
                                                </div>
                                            </>
                                        ) : (
                                            <div className="ticker-no-price">No Price Data</div>
                                        )}
                                        <div className="ticker-source" title={error || source}>{error ? 'Error' : source}</div>
                                    </div>
                                );
                            })}
                        <div className="ticker-refresh" onClick={() => fetchUniswapPrices()} title="Refresh Uniswap Prices">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                            </svg>
                        </div>
                    </div>
                </div>
            )}

            {/* NFT Preview */}
            {metadata && (
                <div className="nft-preview" style={{ marginBottom: '2rem', background: 'var(--bg-secondary)', padding: '1rem', borderRadius: '12px' }}>
                    <div style={{ display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
                        <div style={{ minWidth: '200px' }}>
                            <SmartMedia
                                srcList={[
                                    nftImage,
                                    metadata?.image,
                                    metadata?.image_url,
                                    metadata?.imageUrl,
                                    metadata?.animation_url,
                                    metadata?.animationUrl,
                                ]}
                                alt={nftName}
                                width={200}
                                height={200}
                                seed={`${String(formData.nftContract)}-${String(formData.tokenId)}`}
                                title={nftName}
                            />
                        </div>
                        <div style={{ flex: 1 }}>
                            <h3>{nftName}</h3>
                            <p>{metadata?.description || 'No description available'}</p>

                            {Array.isArray(metadata?.attributes) && metadata.attributes.length > 0 && (
                                <div style={{ marginTop: '1rem' }}>
                                    <h4>Properties</h4>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '0.5rem' }}>
                                        {metadata.attributes.slice(0, 6).map((attr, index) => {
                                            const rarity = getTraitRarity(attr);
                                            return (
                                                <div key={index} style={{
                                                    padding: '0.5rem',
                                                    background: 'var(--bg-tertiary)',
                                                    borderRadius: '6px',
                                                    border: `1px solid ${rarity.color}`
                                                }}>
                                                    <div style={{ fontSize: '0.75rem', color: rarity.color, fontWeight: 600 }}>
                                                        {attr.trait_type || 'Property'}
                                                    </div>
                                                    <div style={{ fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                                                        {attr.value?.toString() || 'Unknown'}
                                                    </div>
                                                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                                        {rarity.label} ({rarity.percentage})
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            <div className="sell-layout">
                <div className="sell-form">
                    <div className={`card glow-card ${auctionSuccess ? 'confetti' : ''}`}>
                        <form onSubmit={handleSubmit}>
                            <div className="form-section">
                                <h3>NFT Details</h3>

                                <div className="form-group">
                                    <label htmlFor="nftContract">NFT Contract Address</label>
                                    <input
                                        type="text"
                                        id="nftContract"
                                        name="nftContract"
                                        className="input"
                                        value={formData.nftContract}
                                        onChange={handleChange}
                                        placeholder="0x..."
                                        required
                                    />
                                </div>

                                <div className="form-group">
                                    <label htmlFor="tokenId">Token ID</label>
                                    <input
                                        type="text"
                                        id="tokenId"
                                        name="tokenId"
                                        className="input"
                                        value={formData.tokenId}
                                        onChange={handleChange}
                                        placeholder="1"
                                        required
                                    />
                                </div>

                                {!metadata && !loading && (
                                    <button type="button" className="secondary-button fetch-button" onClick={fetchNftMetadata}>
                                        Fetch NFT Data
                                    </button>
                                )}

                                {loading && (
                                    <div className="form-group">
                                        <div className="skeleton text"></div>
                                        <div className="skeleton block"></div>
                                    </div>
                                )}
                            </div>

                            {nftType && (
                                <div className="form-section">
                                    <h3>Auction Details</h3>

                                    <div className="form-group">
                                        <label htmlFor="quantity">Quantity to Auction</label>
                                        <div className="input-with-info">
                                            <input
                                                type="number"
                                                id="quantity"
                                                name="quantity"
                                                className="input"
                                                value={formData.quantity}
                                                onChange={handleChange}
                                                placeholder="1"
                                                min="1"
                                                max={balance}
                                                required
                                            />
                                            <div className="input-info">
                                                Available: <span className="chip">{balance}</span>
                                            </div>
                                        </div>
                                        {nftType === 'ERC721' && <div className="small">ERC-721 NFTs are unique and quantity will be 1</div>}
                                    </div>

                                    <div className="form-row">
                                        <div className="form-group">
                                            <label htmlFor="startPrice">Starting Bid</label>
                                            <div className="price-input-container">
                                                <input
                                                    type="text"
                                                    id="startPrice"
                                                    name="startPrice"
                                                    className="input price-input"
                                                    value={formData.startPrice}
                                                    onChange={handleChange}
                                                    placeholder="0.00"
                                                />
                                                <div className="price-conversion">
                                                    <div className="price-eth">
                                                        {formData.startPrice || '0'} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                    </div>
                                                    <div className="price-usd">
                                                        ≈ {startPriceUSD === 'Unknown' ? 'Unknown USD value' : `$${startPriceUSD} USD`}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="form-group">
                                            <label htmlFor="reservePrice">Reserve Price</label>
                                            <div className="price-input-container">
                                                <input
                                                    type="text"
                                                    id="reservePrice"
                                                    name="reservePrice"
                                                    className="input price-input"
                                                    value={formData.reservePrice}
                                                    onChange={handleChange}
                                                    placeholder="1.0"
                                                    required
                                                />
                                                <div className="price-conversion">
                                                    <div className="price-eth">
                                                        {formData.reservePrice || '0'} {tokenList[formData.paymentToken]?.symbol || 'VTRU'}
                                                    </div>
                                                    <div className="price-usd">
                                                        ≈ {reservePriceUSD === 'Unknown' ? 'Unknown USD value' : `$${reservePriceUSD} USD`}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Payment token selector with enhanced UI */}
                                    <div className="form-group">
                                        <div className="payment-header">
                                            <label>Payment Token</label>
                                            <button
                                                type="button"
                                                className="add-token-button"
                                                onClick={() => setShowAddTokenForm(!showAddTokenForm)}
                                            >
                                                {showAddTokenForm ? 'Cancel' : '+ Add Custom Token'}
                                            </button>
                                        </div>

                                        {showAddTokenForm && (
                                            <div className="custom-token-form">
                                                <h4>Add Custom Token</h4>

                                                <div className="form-group">
                                                    <label htmlFor="address">Token Address *</label>
                                                    <input
                                                        type="text"
                                                        id="address"
                                                        className="input"
                                                        value={customTokenData.address}
                                                        onChange={handleCustomTokenChange}
                                                        placeholder="0x..."
                                                        required
                                                    />
                                                </div>

                                                <div className="form-row">
                                                    <div className="form-group">
                                                        <label htmlFor="symbol">Symbol</label>
                                                        <input
                                                            type="text"
                                                            id="symbol"
                                                            className="input"
                                                            value={customTokenData.symbol}
                                                            onChange={handleCustomTokenChange}
                                                            placeholder="Auto-detect if available"
                                                        />
                                                    </div>
                                                    <div className="form-group">
                                                        <label htmlFor="decimals">Decimals</label>
                                                        <input
                                                            type="number"
                                                            id="decimals"
                                                            className="input"
                                                            value={customTokenData.decimals}
                                                            onChange={handleCustomTokenChange}
                                                            placeholder="18"
                                                        />
                                                    </div>
                                                </div>

                                                <div className="form-group">
                                                    <label htmlFor="name">Token Name</label>
                                                    <input
                                                        type="text"
                                                        id="name"
                                                        className="input"
                                                        value={customTokenData.name}
                                                        onChange={handleCustomTokenChange}
                                                        placeholder="Auto-detect if available"
                                                    />
                                                </div>

                                                <div className="form-group">
                                                    <label htmlFor="price">USD Price (optional)</label>
                                                    <div className="input-with-info">
                                                        <input
                                                            type="number"
                                                            id="price"
                                                            className="input"
                                                            value={customTokenData.price}
                                                            onChange={handleCustomTokenChange}
                                                            placeholder="Token USD price"
                                                            step="0.000001"
                                                        />
                                                        <div className="input-info">Will try to find Uniswap pool if left empty</div>
                                                    </div>
                                                </div>

                                                {customTokenError && <div className="error-message">{customTokenError}</div>}

                                                <div className="form-actions token-actions">
                                                    <button type="button" className="secondary-button" onClick={() => setShowAddTokenForm(false)}>
                                                        Cancel
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="primary-button"
                                                        onClick={addCustomToken}
                                                        disabled={!customTokenData.address || loadingPrices}
                                                    >
                                                        {loadingPrices ? 'Adding...' : 'Add Token'}
                                                    </button>
                                                </div>
                                            </div>
                                        )}

                                        {loadingPrices && !showAddTokenForm ? (
                                            <div className="loading-tokens">
                                                <div className="loader"></div>
                                                <p>Loading token information from Uniswap...</p>
                                            </div>
                                        ) : (
                                            <div className="token-dropdown-container">
                                                <div className="token-dropdown-wrapper">
                                                    <select className="token-dropdown" value={formData.paymentToken} onChange={handlePaymentTokenChange}>
                                                        <option value="" disabled>
                                                            Select payment token
                                                        </option>
                                                        {paymentOptions.map((option) => (
                                                            <option key={option.address} value={option.address}>
                                                                {option.name} - $
                                                                {option.price !== null
                                                                    ? option.price < 0.01
                                                                        ? option.price.toFixed(6)
                                                                        : option.price.toFixed(2)
                                                                    : 'No price'}{' '}
                                                                USD
                                                            </option>
                                                        ))}
                                                    </select>
                                                    <div className="dropdown-icon">
                                                        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                                            <path d="M7 10l5 5 5-5z" />
                                                        </svg>
                                                    </div>
                                                </div>

                                                {formData.paymentToken && paymentOptions.length > 0 && (
                                                    <div className="selected-token-details">
                                                        {(() => {
                                                            const selected = paymentOptions.find((o) => o.address === formData.paymentToken);
                                                            if (!selected) return null;

                                                            return (
                                                                <div className={`token-details-card ${selected.error ? 'has-error' : ''}`}>
                                                                    <div className="token-details-header">
                                                                        <div className="token-details-info">
                                                                            <div className="token-details-name">{selected.name}</div>
                                                                            <div className="token-details-full-name">{selected.fullName}</div>
                                                                        </div>
                                                                        <div className="token-details-price-info">
                                                                            {selected.price !== null ? (
                                                                                <div className="token-details-price">
                                                                                    ${selected.price < 0.01 ? selected.price.toFixed(6) : selected.price.toFixed(2)} USD
                                                                                </div>
                                                                            ) : (
                                                                                <div className="token-details-price-unknown">No price data</div>
                                                                            )}
                                                                            <div className={`token-details-source ${selected.error ? 'error' : ''}`} title={selected.error}>
                                                                                {selected.error ? '⚠️ ' + selected.error : selected.priceSource}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })()}
                                                    </div>
                                                )}

                                                {paymentOptions.length === 0 && <div className="no-tokens-message">No tokens available. Add a custom token to continue.</div>}
                                            </div>
                                        )}
                                    </div>

                                    <div className="form-row">
                                        <div className="form-group">
                                            <label htmlFor="duration">Duration (hours)</label>
                                            <select
                                                id="duration"
                                                name="duration"
                                                className="input"
                                                value={formData.duration}
                                                onChange={handleChange}
                                                required
                                            >
                                                <option value="1">1 hour</option>
                                                <option value="6">6 hours</option>
                                                <option value="12">12 hours</option>
                                                <option value="24">24 hours</option>
                                                <option value="48">48 hours</option>
                                                <option value="168">7 days</option>
                                            </select>
                                        </div>

                                        <div className="form-group">
                                            <label htmlFor="minBidIncrementBps">Min Bid Increment (%)</label>
                                            <select
                                                id="minBidIncrementBps"
                                                name="minBidIncrementBps"
                                                className="input"
                                                value={formData.minBidIncrementBps}
                                                onChange={handleChange}
                                                required
                                            >
                                                <option value="100">1%</option>
                                                <option value="250">2.5%</option>
                                                <option value="500">5%</option>
                                                <option value="1000">10%</option>
                                            </select>
                                        </div>
                                    </div>

                                    <div className="form-group">
                                        <label htmlFor="antiSnipeSeconds">Anti-Snipe Extension (minutes)</label>
                                        <select
                                            id="antiSnipeSeconds"
                                            name="antiSnipeSeconds"
                                            className="input"
                                            value={formData.antiSnipeSeconds}
                                            onChange={handleChange}
                                            required
                                        >
                                            <option value="300">5 minutes</option>
                                            <option value="600">10 minutes</option>
                                            <option value="900">15 minutes</option>
                                            <option value="1800">30 minutes</option>
                                        </select>
                                        <small>Auction will extend by this duration if a bid is placed near the end</small>
                                    </div>
                                </div>
                            )}

                            <div className="form-actions">
                                <div className="approval-note">
                                    <svg viewBox="0 0 24 24" width="16" height="16">
                                        <path
                                            fill="currentColor"
                                            d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"
                                        />
                                    </svg>
                                    <span>Note: You'll need to approve the marketplace to transfer your NFT. This is a one-time action per collection.</span>
                                </div>

                                {!wallet ? (
                                    <button type="button" className="secondary-button" onClick={connect}>
                                        Connect Wallet First
                                    </button>
                                ) : !ownershipVerified && metadata ? (
                                    <button type="button" className="warning-button" disabled>
                                        You don't own this NFT
                                    </button>
                                ) : (
                                    <button
                                        type="submit"
                                        className="primary-button"
                                        disabled={!wallet || !metadata || (typeof status === 'string' && status.includes('Creating')) || !ownershipVerified}
                                    >
                                        {typeof status === 'string' && status.includes('Creating') ? 'Processing...' : 'Create Auction'}
                                    </button>
                                )}
                            </div>

                            {status && (
                                <div className={`status-message ${String(status).includes('Warning') ? 'warning' : ''}`}>
                                    {status.includes('Error') ? (
                                        <span className="chip error">{status}</span>
                                    ) : status.includes('Warning') ? (
                                        <span className="chip warn">{status}</span>
                                    ) : status.includes('Success') ? (
                                        <span className="chip success">{status}</span>
                                    ) : (
                                        status
                                    )}
                                </div>
                            )}
                        </form>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default CreateAuctionPage;