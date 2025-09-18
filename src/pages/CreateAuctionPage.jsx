import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ethers } from 'ethers';
import { useWallet } from '../context/WalletContext';
import { useMarketplace } from '../context/MarketplaceContext';
import { useSupabase } from '../context/SupabaseContext';
import { getSupportedTokens, formatTokenAmount } from '../utils/tokenRegistry';
import { fetchTokenPriceInUSDC } from '../utils/tokenUtils';
import { refreshUserNFTCollections } from '../utils/nftOwnershipUtils';
import EnhancedPriceTicker from '../components/EnhancedPriceTicker';
import VtruMarketplaceArtifact from '../abi/VTRUNFTMarketplace.json';
import { debugLog, debugWarn, criticalError } from '../utils/debugUtils';
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

// ERC-165 interface check
const ERC165_ABI = [
  'function supportsInterface(bytes4 interfaceId) view returns (bool)'
];

// ERC-721 (full we need: read + approvals)
const ERC721_ABI = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function balanceOf(address owner) view returns (uint256)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function approve(address to, uint256 tokenId)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
];

const ERC1155_ABI = [
  'function uri(uint256 id) view returns (string)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
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

// Token addresses (Vitruveo chain)
const WVTRU_ADDRESS = '0x3ccc3F22462cAe34766820894D04a40381201ef9';
const USDC_ADDRESS  = '0xbCfB3FCa16b12C7756CD6C24f1cC0AC0E38569CF';
const VUSD_ADDRESS  = '0x1D607d8c617A09c638309bE2Ceb9b4afF42236dA';
const SEVO_ADDRESS  = '0x2A34059DF3D60B1864f10F10492746bd26d3D24a';
const WSEVO_ADDRESS = '0x43a36604B6Ad9A4cf8EF600241E90b3DD97E145d';
const VITEX_ADDRESS = '0x4Ed92A1d95d2092973007197794542A5D51FF5a6';
const VTRO_ADDRESS  = '0xDECAF2f187Cb837a42D26FA364349Abc3e80Aa5D';

// Uniswap V3 (Vitruveo)
const UNISWAP_V3_FACTORY_ADDRESS = '0x6196a7a6108B15a2cc24DdaB41C8CC3098C06351';
const FEE_TIERS = [500, 3000, 10000];

/* =========================================================
   Helpers (tokenId normalization)
   ========================================================= */
function normalizeTokenId(raw) {
  if (raw == null) throw new Error('Missing tokenId');
  const s = String(raw).trim();
  // Accept decimal ("123") or hex ("0x7b")
  return BigInt(s);
}

/* =========================================================
   Component
   ========================================================= */
function CreateAuctionPage() {
  const navigate = useNavigate();
  const { wallet, connect, provider, signer, isCorrectNetwork } = useWallet();
  const { status, setStatus, marketplaceAddress } = useMarketplace();
  const { cacheAuctions, getCachedProfile, cacheProfileData } = useSupabase();
  const [searchParams] = useSearchParams();

  const [formData, setFormData] = useState({
    nftContract: searchParams.get('contract') || '',
    tokenId: searchParams.get('tokenId') || '',
    quantity: '1',
    // Reserve is OPTIONAL — allow blank or 0
    reservePrice: '',
    startPrice: '',
    duration: '24', // hours
    paymentToken: ethers.ZeroAddress, // default to native VTRU
    minBidIncrementBps: '500', // 5%
    antiSnipeSeconds: '600', // 10 minutes
  });

  // New dropdown states
  const [userNftCollections, setUserNftCollections] = useState([]);
  const [selectedContract, setSelectedContract] = useState('');
  const [availableTokenIds, setAvailableTokenIds] = useState([]);
  const [loadingCollections, setLoadingCollections] = useState(false);
  const [contractNames, setContractNames] = useState({});
  const [inputMode, setInputMode] = useState('manual'); // 'dropdown' or 'manual'
  
  // Token metadata for dropdown images
  const [tokenMetadata, setTokenMetadata] = useState({});
  const [loadingTokenMetadata, setLoadingTokenMetadata] = useState(false);
  const [tokenDropdownOpen, setTokenDropdownOpen] = useState(false);
  const dropdownRef = useRef(null);

  const [metadata, setMetadata] = useState(null);
  const [nftImage, setNftImage] = useState('');
  const [nftName, setNftName] = useState('');
  const [nftType, setNftType] = useState(null);
  const [balance, setBalance] = useState('0');
  const [loading, setLoading] = useState(false);

  // NEW: “canTransfer” = you are owner OR approved (721) OR operator (721) OR have 1155 balance > 0
  const [canTransfer, setCanTransfer] = useState(false);
  const [auctionSuccess, setAuctionSuccess] = useState(false);

  // Token system state
  const [startPriceUSD, setStartPriceUSD] = useState('0.00');
  const [reservePriceUSD, setReservePriceUSD] = useState('0.00');
  const [tokenList, setTokenList] = useState({});
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

  useEffect(() => {
    document.title = 'Create Auction • BlockDust';
  }, []);

  // Load user's NFT collections from Supabase with ownership verification
  const loadUserCollections = async (forceRefresh = false) => {
    if (!wallet || !getCachedProfile || !provider) return;
    
    setLoadingCollections(true);
    try {
      let nfts = [];
      
      if (forceRefresh) {
        // Refresh and verify ownership
        nfts = await refreshUserNFTCollections(
          wallet,
          provider,
          getCachedProfile,
          cacheProfileData,
          (status) => debugLog(`[CreateAuctionPage] ${status}`)
        );
      } else {
        // Load from cache
        const cachedProfile = await getCachedProfile(wallet);
        nfts = (cachedProfile && cachedProfile.nfts) || [];
      }
      
      if (nfts.length > 0) {
        // Group NFTs by contract address
        const collections = {};
        nfts.forEach(nft => {
          const contract = nft.contractAddress.toLowerCase();
          if (!collections[contract]) {
            collections[contract] = {
              contractAddress: nft.contractAddress,
              tokens: []
            };
          }
          collections[contract].tokens.push({
            tokenId: nft.tokenId,
            balance: nft.balance,
            type: nft.type
          });
        });
        
        const collectionsArray = Object.values(collections);
        setUserNftCollections(collectionsArray);
        
        // Get contract names for all collections
        await fetchContractNames(collectionsArray.map(c => c.contractAddress));
      } else {
        setUserNftCollections([]);
      }
    } catch (error) {
      debugWarn('Error loading user collections:', error);
      setUserNftCollections([]);
    } finally {
      setLoadingCollections(false);
    }
  };

  // Fetch contract names for display
  const fetchContractNames = async (contractAddresses) => {
    if (!provider) return;
    
    const names = {};
    
    for (const address of contractAddresses) {
      try {
        // Try ERC721 first
        try {
          const contract721 = new ethers.Contract(address, ERC721_ABI, provider);
          const [name, symbol] = await Promise.all([
            contract721.name().catch(() => ''),
            contract721.symbol().catch(() => '')
          ]);
          names[address] = name || symbol || 'Unknown Collection';
        } catch {
          // Try ERC1155
          try {
            const contract1155 = new ethers.Contract(address, ERC1155_ABI, provider);
            const [name, symbol] = await Promise.all([
              contract1155.name().catch(() => ''),
              contract1155.symbol().catch(() => '')
            ]);
            names[address] = name || symbol || 'Unknown Collection';
          } catch {
            names[address] = 'Unknown Collection';
          }
        }
      } catch {
        names[address] = 'Unknown Collection';
      }
    }
    
    setContractNames(names);
  };

  // Handle contract selection from dropdown
  const handleContractSelection = (contractAddress) => {
    setSelectedContract(contractAddress);
    
    if (contractAddress === 'manual') {
      setInputMode('manual');
      setAvailableTokenIds([]);
      setTokenMetadata({});
      setFormData(prev => ({ ...prev, nftContract: '', tokenId: '' }));
      return;
    }
    
    setInputMode('dropdown');
    
    // Find the selected collection and populate token IDs
    const collection = userNftCollections.find(c => 
      c.contractAddress.toLowerCase() === contractAddress.toLowerCase()
    );
    
    if (collection) {
      setAvailableTokenIds(collection.tokens);
      setFormData(prev => ({ 
        ...prev, 
        nftContract: collection.contractAddress,
        tokenId: '' 
      }));
      
      // Load metadata for tokens to show images
      loadTokenMetadata(contractAddress, collection.tokens);
    }
  };

  // Load metadata for available tokens to show images in dropdown
  const loadTokenMetadata = async (contractAddress, tokens) => {
    if (!tokens.length || !provider) return;
    
    setLoadingTokenMetadata(true);
    const metadataMap = {};
    
    try {
      // Load metadata for each token
      for (const token of tokens.slice(0, 20)) { // Limit to first 20 for performance
        try {
          const metadataKey = `${contractAddress.toLowerCase()}-${token.tokenId}`;
          
          // Try to get metadata using existing functions
          const tokenContract = new ethers.Contract(contractAddress, ERC721_ABI, provider);
          let tokenURI = '';
          
          try {
            tokenURI = await tokenContract.tokenURI(token.tokenId);
          } catch (error) {
            // Try ERC1155 if ERC721 fails
            try {
              const tokenContract1155 = new ethers.Contract(contractAddress, ERC1155_ABI, provider);
              tokenURI = await tokenContract1155.uri(token.tokenId);
            } catch (error1155) {
              debugWarn(`Failed to get tokenURI for ${metadataKey}:`, error1155);
              continue;
            }
          }
          
          if (tokenURI) {
            const candidates = metadataCandidatesFromUri(tokenURI, token.tokenId, token.type === 'ERC1155');
            const { json: metadata } = await fetchJsonFromCandidates(candidates, 5000);
            
            if (metadata) {
              // Get image URLs
              const imageUrl = metadata.image || metadata.image_url || metadata.imageUrl;
              let resolvedImageUrl = '';
              
              if (imageUrl) {
                const imageCandidates = expandToCandidateUrls(imageUrl);
                try {
                  resolvedImageUrl = await findFirstWorkingImage(imageCandidates, 3000);
                } catch {
                  // Use fallback image
                  resolvedImageUrl = svgFallbackDataUrl({
                    seed: metadataKey,
                    width: 60,
                    height: 60,
                    title: metadata.name || `Token #${token.tokenId}`
                  });
                }
              } else {
                resolvedImageUrl = svgFallbackDataUrl({
                  seed: metadataKey,
                  width: 60,
                  height: 60,
                  title: metadata.name || `Token #${token.tokenId}`
                });
              }
              
              metadataMap[metadataKey] = {
                name: metadata.name || `Token #${token.tokenId}`,
                description: metadata.description || '',
                image: resolvedImageUrl,
                ...token
              };
            }
          }
        } catch (error) {
          debugWarn(`Failed to load metadata for token ${token.tokenId}:`, error);
          // Add fallback metadata
          const metadataKey = `${contractAddress.toLowerCase()}-${token.tokenId}`;
          metadataMap[metadataKey] = {
            name: `Token #${token.tokenId}`,
            description: '',
            image: svgFallbackDataUrl({
              seed: metadataKey,
              width: 60,
              height: 60,
              title: `Token #${token.tokenId}`
            }),
            ...token
          };
        }
      }
    } finally {
      setTokenMetadata(metadataMap);
      setLoadingTokenMetadata(false);
    }
  };

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setTokenDropdownOpen(false);
      }
    };

    if (tokenDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [tokenDropdownOpen]);

  // Handle token ID selection from dropdown
  const handleTokenIdSelection = (tokenId) => {
    setFormData(prev => ({ ...prev, tokenId }));
    
    // Also set quantity for ERC1155 tokens
    const selectedToken = availableTokenIds.find(t => t.tokenId === tokenId);
    if (selectedToken && selectedToken.type === 'ERC1155') {
      setFormData(prev => ({ ...prev, quantity: selectedToken.balance }));
    }
  };

  // Load user collections when wallet changes
  useEffect(() => {
    if (wallet && provider) {
      loadUserCollections();
    }
  }, [wallet, provider, getCachedProfile]);

  const calculateUSDValue = (amount, tokenAddress) => {
    // Blank or zero is OK → $0.00
    if (amount === '' || amount === null || typeof amount === 'undefined') return '0.00';
    if (isNaN(parseFloat(amount)) || !tokenAddress) return '0.00';
    const priceKey = tokenAddress === ethers.ZeroAddress ? WVTRU_ADDRESS : tokenAddress;
    const currentPrice = livePrice[priceKey];
    if (!currentPrice || typeof currentPrice !== 'number') return 'Unknown';
    if (tokenAddress === USDC_ADDRESS || tokenAddress === 'USDC') return parseFloat(amount).toFixed(2);
    return (parseFloat(amount) * currentPrice).toFixed(2);
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (name === 'reservePrice') setReservePriceUSD(calculateUSDValue(value, formData.paymentToken));
    else if (name === 'startPrice') setStartPriceUSD(calculateUSDValue(value, formData.paymentToken));
    
    // Handle manual input mode changes
    if (inputMode === 'manual') {
      if (name === 'nftContract') {
        setSelectedContract('');
        setAvailableTokenIds([]);
      }
    }
  };

  const handlePaymentTokenChange = (e) => {
    const tokenAddress = e.target.value;
    setFormData(prev => ({ ...prev, paymentToken: tokenAddress }));
    setStartPriceUSD(calculateUSDValue(formData.startPrice, tokenAddress));
    setReservePriceUSD(calculateUSDValue(formData.reservePrice, tokenAddress));
  };

  const formatTime = (date) => (date ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

  useEffect(() => {
    return () => { if (priceIntervalRef.current) clearInterval(priceIntervalRef.current); };
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
      criticalError(err);
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
      Object.entries(newPrices).forEach(([a, p]) => { validated[a] = typeof p === 'number' && p >= 0 ? p : null; });

      setLivePrice(validated);
      setPriceChange(changes);
      setPriceSources(newSources);
      setPriceErrors(errors);
      setLastUpdateTime(new Date());

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

      await addToken(VUSD_ADDRESS,  'VUSD',  'VUSD Token', 6);
      await addToken(SEVO_ADDRESS,  'SEVO',  'SEVO Token');
      await addToken(WSEVO_ADDRESS, 'WSEVO', 'Wrapped SEVO');
      await addToken(VITEX_ADDRESS, 'VITEX', 'VITEX Token');
      await addToken(VTRO_ADDRESS,  'VTRO',  'VTRO Token');

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

  useEffect(() => {
    if (formData.paymentToken) {
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

  /* =========================
     NFT metadata + rights (robust)
     ========================= */
  function mediaCandidatesFromMetadata(m) {
    if (!m || typeof m !== 'object') return [];
    return [m.image, m.image_url, m.imageUrl, m.animation_url, m.animationUrl].filter(isString);
  }

  const fetchNftMetadata = async () => {
    if (!formData.nftContract || !formData.tokenId) { setStatus('Please enter contract address and token ID'); return; }
    if (!wallet) { setStatus('Please connect your wallet first'); return; }
    if (!provider) { setStatus('No provider available. Please reconnect your wallet.'); return; }

    setLoading(true);
    setStatus('Fetching NFT metadata...');
    setMetadata(null);
    setNftImage('');
    setNftName('');
    setCanTransfer(false);
    setNftType(null);

    try {
      if (!ethers.isAddress(formData.nftContract)) throw new Error('Invalid contract address format');
      const checksum = ethers.getAddress(formData.nftContract);
      const tokenIdBN = normalizeTokenId(formData.tokenId);

      // Detect interface
      let is721 = false;
      let is1155 = false;
      try {
        const erc165 = new ethers.Contract(checksum, ERC165_ABI, provider);
        is721  = await erc165.supportsInterface('0x80ac58cd'); // ERC-721
        is1155 = await erc165.supportsInterface('0xd9b67a26'); // ERC-1155
      } catch {
        // If contract is quirky, we'll probe methods
      }

      // --- Try ERC-721 path first (or when unknown but not 1155)
      if (is721 || (!is1155)) {
        try {
          const erc721 = new ethers.Contract(checksum, ERC721_ABI, provider);
          const owner = await erc721.ownerOf(tokenIdBN);

          // Transfer rights: owner OR approved OR operator
          let approved = ethers.ZeroAddress;
          try { approved = await erc721.getApproved(tokenIdBN); } catch {}
          let isOp = false;
          try { isOp = await erc721.isApprovedForAll(owner, wallet); } catch {}

          const ownerEq    = (owner?.toLowerCase?.() === wallet?.toLowerCase?.());
          const approvedEq = (approved?.toLowerCase?.() === wallet?.toLowerCase?.());
          const canXfer    = ownerEq || approvedEq || !!isOp;

          setCanTransfer(!!canXfer);
          setNftType('ERC721');
          setBalance('1');

          if (!canXfer) {
            setStatus(`Warning: Owner is ${owner}, and your wallet has no transfer approval.`);
            setLoading(false);
            return;
          }

          // tokenURI + media
          let tokenURI = '';
          try { tokenURI = await erc721.tokenURI(tokenIdBN); } catch {}
          if (tokenURI) {
            const metaCands = metadataCandidatesFromUri(tokenURI, tokenIdBN.toString(), false);
            try {
              const { json } = await fetchJsonFromCandidates(metaCands);
              setMetadata(json);
              setNftName(json?.name || `NFT #${tokenIdBN.toString()}`);
              try {
                const media = uniq(flatten(mediaCandidatesFromMetadata(json).map(expandToCandidateUrls)));
                const firstVideo = media.find(isVideoUrl);
                if (firstVideo) setNftImage(firstVideo); else setNftImage(await findFirstWorkingImage(media));
              } catch { setNftImage(''); }
            } catch { /* tolerate missing metadata */ }
          }

          setStatus('');
          return; // done
        } catch {
          // fallthrough to 1155
        }
      }

      // --- ERC-1155 path
      if (is1155 || !is721) {
        try {
          const erc1155 = new ethers.Contract(checksum, ERC1155_ABI, provider);
          const bal = await erc1155.balanceOf(wallet, tokenIdBN);
          const ownerBalance = bal.toString();
          setBalance(ownerBalance);

          const hasSome = BigInt(ownerBalance) > 0n;
          setCanTransfer(hasSome);
          setNftType('ERC1155');

          if (!hasSome) { setStatus('Warning: You do not own any of these tokens'); setLoading(false); return; }

          let uri = '';
          try { uri = await erc1155.uri(tokenIdBN); } catch {}
          if (uri) {
            const metaCands = metadataCandidatesFromUri(uri, tokenIdBN.toString(), true);
            try {
              const { json } = await fetchJsonFromCandidates(metaCands);
              setMetadata(json);
              setNftName(json?.name || `NFT #${tokenIdBN.toString()}`);
              try {
                const media = uniq(flatten(mediaCandidatesFromMetadata(json).map(expandToCandidateUrls)));
                const firstVideo = media.find(isVideoUrl);
                if (firstVideo) setNftImage(firstVideo); else setNftImage(await findFirstWorkingImage(media));
              } catch { setNftImage(''); }
            } catch { /* metadata optional */ }
          }

          setFormData((prev) => ({ ...prev, quantity: ownerBalance }));
          setStatus('');
          return;
        } catch {
          // Neither path worked
        }
      }

      setStatus('Could not fetch NFT metadata or verify transfer rights. Check contract address, token ID, and network.');
    } catch (error) {
      setStatus('Error fetching NFT data: ' + (error.message || error));
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
      common:    { label: 'Common',    color: '#78909c', percentage: '25.4%' },
      uncommon:  { label: 'Uncommon',  color: '#26a69a', percentage: '15.2%' },
      rare:      { label: 'Rare',      color: '#5c6bc0', percentage: '8.7%' },
      epic:      { label: 'Epic',      color: '#ab47bc', percentage: '3.2%' },
      legendary: { label: 'Legendary', color: '#ffb300', percentage: '0.9%' },
    };
    const keys = Object.keys(map);
    const i = Math.floor((((trait.trait_type?.length) || 0) + (String(trait.value || '').length)) % 5);
    return map[keys[i]];
  };

  /* =========================
     Submit (createAuction)
     ========================= */
  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!wallet) { await connect(); return; }
    if (!isCorrectNetwork) { setStatus('Error: Wrong network. Please switch to Vitruveo.'); return; }
    if (!canTransfer) { setStatus('Error: You do not have transfer rights for this NFT.'); return; }

    try {
      if (!signer) { setStatus('Error: Wallet not connected. Please connect your wallet first'); return; }
      if (!marketplaceAddress || marketplaceAddress === ethers.ZeroAddress) { throw new Error('Marketplace contract not initialized'); }

      setStatus('Preparing auction...');

      // Start price must be > 0
      if (!formData.startPrice || parseFloat(formData.startPrice) <= 0) {
        setStatus('Error: Starting price must be greater than 0');
        return;
      }

      const token = tokenList[formData.paymentToken];
      if (!token) { setStatus('Error: Please select a valid payment token'); return; }

      // Reserve is OPTIONAL — blank or <=0 -> 0n
      const reservePriceInWei = (!formData.reservePrice || parseFloat(formData.reservePrice) <= 0)
        ? 0n
        : ethers.parseUnits(formData.reservePrice, token.decimals || 18);

      const startPriceInWei = ethers.parseUnits(formData.startPrice, token.decimals || 18);

      const startTimeSec = Math.floor(Date.now() / 1000);
      const endTimeSec = startTimeSec + (parseInt(formData.duration) * 3600);

      // Use nftType from metadata step
      const isERC1155 = (nftType === 'ERC1155');

      // Ensure approvals
      if (isERC1155) {
        const nftContract1155 = new ethers.Contract(formData.nftContract, ERC1155_ABI, signer);
        const isApproved = await nftContract1155.isApprovedForAll(wallet, marketplaceAddress);
        if (!isApproved) {
          setStatus('Requesting approval to auction your NFTs...');
          const approvalTx = await nftContract1155.setApprovalForAll(marketplaceAddress, true);
          setStatus('Approval transaction submitted. Please wait for confirmation...');
          await approvalTx.wait();
          setStatus('Approval confirmed! Creating auction...');
        }
      } else {
        const nftContract721 = new ethers.Contract(formData.nftContract, ERC721_ABI, signer);
        const isApprovedForAll = await nftContract721.isApprovedForAll(wallet, marketplaceAddress);
        if (!isApprovedForAll) {
          // If not operator-approved, still setApprovalForAll — simpler UX
          setStatus('Requesting approval to auction your NFT...');
          const approvalTx = await nftContract721.setApprovalForAll(marketplaceAddress, true);
          setStatus('Approval transaction submitted. Please wait for confirmation...');
          await approvalTx.wait();
          setStatus('Approval confirmed! Creating auction...');
        }
      }

      const contract = new ethers.Contract(marketplaceAddress, VtruMarketplaceArtifact.abi, signer);

      setStatus('Creating auction...');

      const args = [
        ethers.getAddress(formData.nftContract),
        normalizeTokenId(formData.tokenId),
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

      await contract.createAuction.staticCall(...args).catch((e) => { throw new Error(decodeRevert(e)); });

      const overrides = {};
      try {
        const gas = await contract.createAuction.estimateGas(...args);
        overrides.gasLimit = (gas * 12n) / 10n;
      } catch { overrides.gasLimit = 1_200_000n; }
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
      setStatus('Transaction submitted. Waiting for confirmation...');
      const receipt = await tx.wait();
      setStatus('Auction created successfully!');

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
            setStatus('Auction created and cached successfully!');
          }
        }
      } catch (error) {
        debugWarn('Warning: Could not cache auction data:', error);
      }

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

      {/* Enhanced Price Ticker with Blockchain Scanning and History */}
      {Object.keys(tokenList).length > 0 && (
        <EnhancedPriceTicker
          provider={provider}
          tokenList={tokenList}
          onPriceUpdate={(priceData) => {
            // Update legacy price state for compatibility
            const prices = {};
            const changes = {};
            const sources = {};
            const errors = {};
            
            Object.entries(priceData).forEach(([address, data]) => {
              if (data && data.price !== undefined) {
                const priceKey = address === ethers.ZeroAddress ? WVTRU_ADDRESS : address;
                prices[priceKey] = data.price;
                changes[priceKey] = data.changes?.['24h']?.changePercent || 0;
                sources[priceKey] = data.source || 'Unknown';
              }
            });
            
            setLivePrice(prices);
            setPriceChange(changes);
            setPriceSources(sources);
            setPriceErrors(errors);
            setLastUpdateTime(new Date());
          }}
          showAdvancedMetrics={true}
          enableBlockchainScan={true}
          autoRefreshInterval={30000}
        />
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

                {/* Input mode selector */}
                <div className="form-group">
                  <label>Select NFT Input Method</label>
                  <div className="input-mode-selector">
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="inputMode"
                        value="dropdown"
                        checked={inputMode === 'dropdown'}
                        onChange={() => setInputMode('dropdown')}
                        disabled={userNftCollections.length === 0}
                      />
                      <span>From My Collection</span>
                      {userNftCollections.length === 0 && (
                        <small>(No cached NFTs found)</small>
                      )}
                    </label>
                    <label className="radio-option">
                      <input
                        type="radio"
                        name="inputMode"
                        value="manual"
                        checked={inputMode === 'manual'}
                        onChange={() => setInputMode('manual')}
                      />
                      <span>Manual Entry</span>
                    </label>
                  </div>
                </div>

                {/* Dropdown mode */}
                {inputMode === 'dropdown' && (
                  <>
                    <div className="form-group">
                      <div className="collection-header">
                        <label htmlFor="contractDropdown">Select Collection</label>
                        <button
                          type="button"
                          className="refresh-collections-btn"
                          onClick={() => loadUserCollections(true)}
                          disabled={loadingCollections}
                          title="Refresh collection to verify ownership and remove sold NFTs"
                        >
                          {loadingCollections ? (
                            <span className="spinner-small">⟳</span>
                          ) : (
                            '🔄'
                          )}
                          Refresh
                        </button>
                      </div>
                      {loadingCollections ? (
                        <div className="loading-collections">
                          <div className="loader"></div>
                          <span>Loading your collections...</span>
                        </div>
                      ) : (
                        <select
                          id="contractDropdown"
                          className="input"
                          value={selectedContract}
                          onChange={(e) => handleContractSelection(e.target.value)}
                          required
                        >
                          <option value="">Select a collection</option>
                          {userNftCollections.map((collection) => (
                            <option key={collection.contractAddress} value={collection.contractAddress}>
                              {contractNames[collection.contractAddress] || 'Loading...'} 
                              ({collection.contractAddress.slice(0, 6)}...{collection.contractAddress.slice(-4)})
                              {' - '}{collection.tokens.length} NFT{collection.tokens.length !== 1 ? 's' : ''}
                            </option>
                          ))}
                          <option value="manual">⚙️ Manual Entry</option>
                        </select>
                      )}
                    </div>

                    {availableTokenIds.length > 0 && (
                      <div className="form-group">
                        <label htmlFor="tokenIdDropdown">Select Token ID</label>
                        {loadingTokenMetadata ? (
                          <div className="loading-tokens">
                            <div className="loader"></div>
                            <p>Loading NFT previews...</p>
                          </div>
                        ) : (
                          <div className="token-dropdown-with-images" ref={dropdownRef}>
                            <div 
                              className={`token-dropdown-trigger ${tokenDropdownOpen ? 'open' : ''}`}
                              onClick={() => setTokenDropdownOpen(!tokenDropdownOpen)}
                            >
                              {formData.tokenId ? (
                                <div className="selected-token">
                                  {(() => {
                                    const selectedToken = availableTokenIds.find(t => t.tokenId === formData.tokenId);
                                    const metadataKey = `${formData.nftContract.toLowerCase()}-${formData.tokenId}`;
                                    const metadata = tokenMetadata[metadataKey];
                                    return (
                                      <>
                                        {metadata?.image ? (
                                          <img 
                                            src={metadata.image} 
                                            alt={metadata.name}
                                            className="token-preview-image"
                                            onError={(e) => {
                                              e.target.src = svgFallbackDataUrl({
                                                seed: metadataKey,
                                                width: 40,
                                                height: 40,
                                                title: metadata?.name || `Token #${formData.tokenId}`
                                              });
                                            }}
                                          />
                                        ) : (
                                          <img 
                                            src={svgFallbackDataUrl({
                                              seed: metadataKey,
                                              width: 40,
                                              height: 40,
                                              title: `Token #${formData.tokenId}`
                                            })}
                                            alt={`Token #${formData.tokenId}`}
                                            className="token-preview-image"
                                          />
                                        )}
                                        <div className="token-info">
                                          <div className="token-name">
                                            {metadata?.name || `Token #${formData.tokenId}`}
                                          </div>
                                          <div className="token-details">
                                            ID: {formData.tokenId}
                                            {selectedToken?.type === 'ERC1155' ? ` • Balance: ${selectedToken.balance}` : ''}
                                          </div>
                                        </div>
                                      </>
                                    );
                                  })()}
                                </div>
                              ) : (
                                <span className="placeholder">Select a token ID</span>
                              )}
                              <div className="dropdown-arrow">▼</div>
                            </div>
                            
                            {tokenDropdownOpen && (
                              <div className="token-dropdown-menu">
                                {availableTokenIds.map((token) => {
                                  const metadataKey = `${formData.nftContract.toLowerCase()}-${token.tokenId}`;
                                  const metadata = tokenMetadata[metadataKey];
                                  return (
                                    <div
                                      key={token.tokenId}
                                      className={`token-option ${formData.tokenId === token.tokenId ? 'selected' : ''}`}
                                      onClick={() => {
                                        handleTokenIdSelection(token.tokenId);
                                        setTokenDropdownOpen(false);
                                      }}
                                    >
                                      {metadata?.image ? (
                                        <img 
                                          src={metadata.image} 
                                          alt={metadata.name}
                                          className="token-preview-image"
                                          onError={(e) => {
                                            e.target.src = svgFallbackDataUrl({
                                              seed: metadataKey,
                                              width: 40,
                                              height: 40,
                                              title: metadata?.name || `Token #${token.tokenId}`
                                            });
                                          }}
                                        />
                                      ) : (
                                        <img 
                                          src={svgFallbackDataUrl({
                                            seed: metadataKey,
                                            width: 40,
                                            height: 40,
                                            title: `Token #${token.tokenId}`
                                          })}
                                          alt={`Token #${token.tokenId}`}
                                          className="token-preview-image"
                                        />
                                      )}
                                      <div className="token-info">
                                        <div className="token-name">
                                          {metadata?.name || `Token #${token.tokenId}`}
                                        </div>
                                        <div className="token-details">
                                          ID: {token.tokenId}
                                          {token.type === 'ERC1155' ? ` • Balance: ${token.balance}` : ''}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Manual mode */}
                {inputMode === 'manual' && (
                  <>
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
                  </>
                )}

                {!metadata && !loading && formData.nftContract && formData.tokenId && (
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
                          required
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
                      <label htmlFor="reservePrice">Reserve Price (optional)</label>
                      <div className="price-input-container">
                        <input
                          type="text"
                          id="reservePrice"
                          name="reservePrice"
                          className="input price-input"
                          value={formData.reservePrice}
                          onChange={handleChange}
                          placeholder="0 (no reserve)"
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
                ) : !canTransfer && metadata ? (
                  <button type="button" className="warning-button" disabled>
                    You can’t transfer this NFT
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={!wallet || !metadata || (typeof status === 'string' && status.includes('Creating')) || !canTransfer}
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
