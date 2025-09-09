/* =========================================================
   V-Share utility functions for consistent handling across the site
   ========================================================= */

export const VSHARE_ADDRESS = '0xc5d518d131738481947cFa4670F94eb7b948a1ac';

function shortAddress(addr) {
    try { return `${addr.slice(0, 6)}…${addr.slice(-4)}`; } catch { return addr || ''; }
}

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h << 5) - h + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

/**
 * Generates a beautiful LP-style SVG for V-Share NFTs
 */
export function vShareLpSvgDataUrl({
    contract,
    tokenId,
    width = 640,
    height = 460,
    title = 'V-Share',
    subtitle = 'Vmonsters Rev Share'
}) {
    const seed = `${contract}-${tokenId}-vshare`;
    const h = hashString(seed);
    const hue = (h % 360);
    const hue2 = (hue + 140) % 360;
    const hue3 = (hue + 300) % 360;
    const gidA = `g${(h % 1e9).toString(36)}a`;
    const gidB = `g${(h % 1e9).toString(36)}b`;
    const cx = width * 0.62;
    const cy = height * 0.52;
    const rOuter = Math.min(width, height) * 0.38;
    const rLabel = rOuter * 0.34;
    const contractShort = shortAddress(contract);

    const grooves = Array.from({ length: 24 }).map((_, i) => {
        const r = rOuter * (0.65 + i * (0.35 / 24));
        const op = 0.08 + (i % 2 === 0 ? 0.02 : 0);
        return `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="none" stroke="rgba(255,255,255,${op.toFixed(2)})" stroke-width="${i % 4 === 0 ? 1.5 : 0.7}"/>`;
    }).join('');

    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <defs>
    <linearGradient id="${gidA}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},90%,18%)"/>
      <stop offset="100%" stop-color="hsl(${hue2},90%,14%)"/>
    </linearGradient>
    <radialGradient id="${gidB}" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="hsla(${hue3},90%,60%,0.8)"/>
      <stop offset="100%" stop-color="hsla(${hue3},90%,60%,0)"/>
    </radialGradient>
  </defs>

  <rect width="100%" height="100%" fill="url(#${gidA})"/>
  <rect x="0" y="0" width="100%" height="100%" fill="url(#${gidB})" opacity="0.25"/>

  <g>
    <circle cx="${cx}" cy="${cy}" r="${rOuter}" fill="black" stroke="hsla(${hue3},95%,65%,0.35)" stroke-width="4"/>
    ${grooves}
    <circle cx="${cx}" cy="${cy}" r="${rOuter * 0.03}" fill="rgba(255,255,255,0.9)"/>
    <circle cx="${cx}" cy="${cy}" r="${rLabel}" fill="hsl(${hue3},85%,50%)" stroke="rgba(255,255,255,0.4)" stroke-width="2"/>
    <circle cx="${cx}" cy="${cy}" r="${rLabel * 0.92}" fill="rgba(0,0,0,0.22)"/>
    <text x="${cx}" y="${cy - rLabel * 0.24}" fill="#0b0b0b" font-size="${Math.max(18, rLabel * 0.3)}" font-family="ui-sans-serif, system-ui" text-anchor="middle" font-weight="800">V</text>
    <text x="${cx}" y="${cy + rLabel * 0.08}" fill="white" font-size="${Math.max(12, rLabel * 0.22)}" font-family="ui-sans-serif, system-ui" text-anchor="middle" font-weight="700">${title}</text>
    <text x="${cx}" y="${cy + rLabel * 0.32}" fill="rgba(255,255,255,0.85)" font-size="${Math.max(9, rLabel * 0.12)}" font-family="ui-sans-serif, system-ui" text-anchor="middle">${subtitle}</text>
  </g>

  <g>
    <text x="6%" y="16%" fill="rgba(255,255,255,0.9)" font-size="24" font-family="ui-sans-serif, system-ui" font-weight="700">V-Share</text>
    <text x="6%" y="22%" fill="rgba(255,255,255,0.7)" font-size="14" font-family="ui-sans-serif, system-ui">Vmonsters Revenue Share NFT</text>
  </g>

  <g>
    <text x="6%" y="${height - 20}" fill="rgba(255,255,255,0.8)" font-size="12" font-family="ui-monospace">${contractShort} • #${tokenId}</text>
  </g>
</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Returns the standard V-Share description
 */
export function vShareDescriptionBlockDust() {
    return [
        'V-Share Revenue Sharing',
        '',
        'Own a share in the evolving VMonsters ecosystem. Holders receive a share of ecosystem revenue deposited in native VTRU and claimable on-chain.',
        '',
        'Revenue Sources',
        '• 10% of Random Mint proceeds (allocated as revenue)',
        '• 3% of PvP generated income',
        '• Future products: Launchpad fees, new game titles, marketplace features',
        '• Additional ecosystem products announced later are included by default',
        '',
        'Mint payments are excluded to keep incentives aligned.',
        '',
        'Trade V-Share on BlockDust.'
    ].join('\n');
}

/**
 * Alias for consistency with SellPage usage
 */
export function vShareDefaultDescription() {
    return vShareDescriptionBlockDust();
}

/**
 * Checks if a contract address is V-Share
 */
export function isVShareContract(contractAddress) {
    if (!contractAddress) return false;
    return contractAddress.toLowerCase() === VSHARE_ADDRESS.toLowerCase();
}

/**
 * Gets V-Share metadata for a specific token
 */
export function getVShareMetadata(contractAddress, tokenId, title = null) {
    if (!isVShareContract(contractAddress)) return null;
    
    const tokenIdStr = String(tokenId);
    const nftTitle = title || `V-Share #${tokenIdStr}`;
    
    return {
        name: nftTitle,
        description: vShareDefaultDescription(),
        image: vShareLpSvgDataUrl({ 
            contract: contractAddress, 
            tokenId: tokenIdStr, 
            title: 'V-Share', 
            subtitle: 'Vmonsters Rev Share' 
        }),
        imageUrl: vShareLpSvgDataUrl({ 
            contract: contractAddress, 
            tokenId: tokenIdStr, 
            title: 'V-Share', 
            subtitle: 'Vmonsters Rev Share' 
        }),
        attributes: [
            {
                trait_type: 'Collection',
                value: 'V-Share'
            },
            {
                trait_type: 'Type',
                value: 'Revenue Share NFT'
            },
            {
                trait_type: 'Contract',
                value: shortAddress(contractAddress)
            }
        ],
        loaded: true,
        loading: false,
        hasMetadata: true,
        hasImage: true,
        source: 'V-Share Generator'
    };
}