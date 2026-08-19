/**
 * src/config/chains.js — the multichain registry.
 *
 * This module reads localStorage and import.meta.env at module scope, so each
 * test that needs different state re-imports it with vi.resetModules().
 * That mirrors production: the app reloads the page on a chain switch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const STORAGE_KEY = 'blockdust_active_chain';
const HYVE = 7847;
const VITRUVEO = 1490;

/** Minimal localStorage stand-in; the module only uses get/setItem. */
function installStorage(initial = {}) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal('localStorage', {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
    });
    return store;
}

async function loadChains(initialStorage) {
    vi.resetModules();
    installStorage(initialStorage);
    return import('../../src/config/chains.js');
}

beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: 'https://app.test' } });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('registry shape', () => {
    it('defines exactly the two supported chains', async () => {
        const { CHAINS } = await loadChains();
        expect(Object.keys(CHAINS).map(Number).sort()).toEqual([VITRUVEO, HYVE]);
    });

    it('gives each chain the fields the UI depends on', async () => {
        const { CHAINS } = await loadChains();
        for (const chain of Object.values(CHAINS)) {
            expect(chain).toMatchObject({
                id: expect.any(Number),
                key: expect.any(String),
                name: expect.any(String),
                symbol: expect.any(String),
                explorer: expect.stringMatching(/^https:\/\//),
            });
            expect(chain.marketplaceAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
            expect(typeof chain.features).toBe('object');
        }
    });

    it('defaults to Hyve', async () => {
        const { DEFAULT_CHAIN_ID, getActiveChainId } = await loadChains();
        expect(DEFAULT_CHAIN_ID).toBe(HYVE);
        expect(getActiveChainId()).toBe(HYVE);
    });

    it('routes Hyve RPC through the same-origin proxy', async () => {
        // Hyve's upstream blocks browser CORS, so direct calls must not be used.
        const { CHAINS } = await loadChains();
        expect(CHAINS[HYVE].rpcUrl).toBe('https://app.test/api/rpc/hyve');
    });
});

describe('active chain persistence', () => {
    it('reads a previously saved chain', async () => {
        const { getActiveChainId } = await loadChains({ [STORAGE_KEY]: String(VITRUVEO) });
        expect(getActiveChainId()).toBe(VITRUVEO);
    });

    it('falls back to the default when the saved chain is unknown', async () => {
        const { getActiveChainId } = await loadChains({ [STORAGE_KEY]: '999999' });
        expect(getActiveChainId()).toBe(HYVE);
    });

    it('falls back to the default when the saved value is not a number', async () => {
        const { getActiveChainId } = await loadChains({ [STORAGE_KEY]: 'banana' });
        expect(getActiveChainId()).toBe(HYVE);
    });

    it('persists a supported chain and ignores an unsupported one', async () => {
        const { setActiveChainId, getActiveChainId } = await loadChains();

        setActiveChainId(VITRUVEO);
        expect(getActiveChainId()).toBe(VITRUVEO);

        setActiveChainId(1); // Ethereum mainnet is not supported here
        expect(getActiveChainId()).toBe(VITRUVEO);
    });

    it('activeChain() returns the full record for the saved chain', async () => {
        const { activeChain } = await loadChains({ [STORAGE_KEY]: String(VITRUVEO) });
        expect(activeChain().key).toBe('vitruveo');
    });
});

describe('isSupportedChain', () => {
    it('accepts supported ids as number or string', async () => {
        const { isSupportedChain } = await loadChains();
        expect(isSupportedChain(HYVE)).toBe(true);
        expect(isSupportedChain(String(VITRUVEO))).toBe(true);
    });

    it('rejects unsupported ids', async () => {
        const { isSupportedChain } = await loadChains();
        for (const id of [1, 137, 0, null, undefined, 'nonsense']) {
            expect(isSupportedChain(id), String(id)).toBe(false);
        }
    });
});

describe('feature gating', () => {
    it('marks the DeFi primitives as Vitruveo-only', async () => {
        const { chainHasFeature } = await loadChains();
        for (const feature of ['vibe', 'revShare', 'wvtru', 'uniswapPricing']) {
            expect(chainHasFeature(feature, VITRUVEO), `${feature} on Vitruveo`).toBe(true);
            expect(chainHasFeature(feature, HYVE), `${feature} on Hyve`).toBe(false);
        }
    });

    // Auctions are off on both chains: the deployed marketplace escrows the
    // NFT and the bid funds, and the replacement contract drops them.
    it('disables auctions on both chains', async () => {
        const { chainHasFeature } = await loadChains();
        expect(chainHasFeature('auctions', HYVE)).toBe(false);
        expect(chainHasFeature('auctions', VITRUVEO)).toBe(false);
    });

    it('returns false for unknown features and unknown chains', async () => {
        const { chainHasFeature } = await loadChains();
        expect(chainHasFeature('timeTravel', HYVE)).toBe(false);
        expect(chainHasFeature('vibe', 999999)).toBe(false);
    });

    it('defaults to the active chain when no id is passed', async () => {
        const { chainHasFeature } = await loadChains({ [STORAGE_KEY]: String(HYVE) });
        expect(chainHasFeature('vibe')).toBe(false);
    });
});

describe('chainAddress', () => {
    it('returns Vitruveo-only addresses on Vitruveo', async () => {
        const { chainAddress } = await loadChains();
        expect(chainAddress('wvtru', VITRUVEO)).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('returns an empty string on Hyve, which has no such contracts', async () => {
        // Callers rely on '' being falsy to skip Vitruveo-only code paths.
        const { chainAddress } = await loadChains();
        for (const name of ['wvtru', 'usdc', 'vibeSink', 'revShareNft']) {
            expect(chainAddress(name, HYVE), name).toBe('');
        }
    });

    it('returns an empty string for unknown names and chains', async () => {
        const { chainAddress } = await loadChains();
        expect(chainAddress('nope', VITRUVEO)).toBe('');
        expect(chainAddress('wvtru', 999999)).toBe('');
    });
});

describe('explorer links', () => {
    it('builds tx, address, and token urls for the given chain', async () => {
        const { explorerTx, explorerAddress, explorerToken, CHAINS } = await loadChains();
        const base = CHAINS[HYVE].explorer;

        expect(explorerTx('0xabc', HYVE)).toBe(`${base}/tx/0xabc`);
        expect(explorerAddress('0xdef', HYVE)).toBe(`${base}/address/0xdef`);
        expect(explorerToken('0xc', '42', HYVE)).toBe(`${base}/token/0xc/instance/42`);
    });

    it('uses the active chain when no id is passed', async () => {
        const { explorerTx, CHAINS } = await loadChains({ [STORAGE_KEY]: String(VITRUVEO) });
        expect(explorerTx('0x1')).toContain(CHAINS[VITRUVEO].explorer);
    });
});
