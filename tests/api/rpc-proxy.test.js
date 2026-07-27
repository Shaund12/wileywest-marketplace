/**
 * /api/rpc/:chain and /api/ipfs/* on the real backend/server.js.
 *
 * The RPC route is a proxy the browser can reach, so its method allowlist is
 * what stops the backend becoming an open relay to arbitrary JSON-RPC calls.
 * Every upstream fetch is stubbed — nothing here touches the network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { loadServer } from '../helpers/testServer.js';

let app;
let close;

beforeAll(() => {
    ({ app, close } = loadServer());
});

afterAll(async () => {
    await close();
});

/** Stubs the upstream RPC/IPFS host and records what it was asked for. */
function stubUpstream(handler) {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        calls.push({ url: String(url), init });
        return handler
            ? handler(String(url), init)
            : {
                ok: true,
                status: 200,
                headers: new Map([['content-type', 'application/json']]),
                text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }),
            };
    }));
    return calls;
}

beforeEach(() => {
    vi.unstubAllGlobals();
});

const rpc = (chain, body) => request(app).post(`/api/rpc/${chain}`).send(body);
const call = (method, params = []) => ({ jsonrpc: '2.0', id: 1, method, params });

describe('chain routing', () => {
    it('rejects an unknown chain', async () => {
        stubUpstream();
        const res = await rpc('ethereum', call('eth_blockNumber'));

        expect(res.status).toBe(404);
        expect(res.body.error).toBe('Unsupported chain');
    });

    it('accepts the two supported chains', async () => {
        for (const chain of ['hyve', 'vitruveo']) {
            stubUpstream();
            const res = await rpc(chain, call('eth_chainId'));
            expect(res.status, chain).toBe(200);
        }
    });
});

describe('method allowlist', () => {
    it('forwards allowlisted read methods', async () => {
        const calls = stubUpstream();
        const res = await rpc('hyve', call('eth_blockNumber'));

        expect(res.status).toBe(200);
        expect(calls).toHaveLength(1);
    });

    it('refuses methods that are not allowlisted', async () => {
        // These are the dangerous ones: node administration and key access.
        const forbidden = [
            'eth_accounts',
            'personal_unlockAccount',
            'admin_addPeer',
            'debug_traceTransaction',
            'miner_start',
            'eth_sign',
        ];

        for (const method of forbidden) {
            const calls = stubUpstream();
            const res = await rpc('hyve', call(method));

            expect(res.status, method).toBe(400);
            expect(res.body.error).toMatch(/not allowed/);
            // Never even contacted upstream.
            expect(calls, method).toHaveLength(0);
        }
    });

    it('requires jsonrpc 2.0', async () => {
        const calls = stubUpstream();
        const res = await rpc('hyve', { id: 1, method: 'eth_blockNumber', params: [] });

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('rejects non-array params', async () => {
        stubUpstream();
        const res = await rpc('hyve', { jsonrpc: '2.0', id: 1, method: 'eth_call', params: { to: '0x1' } });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/params must be an array/);
    });
});

describe('batching', () => {
    it('accepts a batch of allowlisted calls', async () => {
        stubUpstream();
        const res = await rpc('hyve', [call('eth_chainId'), call('eth_blockNumber')]);
        expect(res.status).toBe(200);
    });

    it('rejects a batch larger than 20', async () => {
        const calls = stubUpstream();
        const batch = Array.from({ length: 21 }, () => call('eth_blockNumber'));
        const res = await rpc('hyve', batch);

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/batch size/);
        expect(calls).toHaveLength(0);
    });

    it('rejects an empty batch', async () => {
        stubUpstream();
        const res = await rpc('hyve', []);
        expect(res.status).toBe(400);
    });

    it('rejects a batch containing a single forbidden method', async () => {
        // One bad apple must fail the whole batch, not be silently dropped.
        const calls = stubUpstream();
        const res = await rpc('hyve', [call('eth_chainId'), call('admin_addPeer')]);

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });
});

describe('caching and failover', () => {
    it('serves a repeated cacheable read from cache', async () => {
        const calls = stubUpstream();
        // The RPC cache is module-level and keyed by chain+method+params, so
        // use params no other test uses to guarantee a cold start here.
        const probe = call('eth_getCode', ['0xcacheprobe0000000000000000000000000000001', 'latest']);

        const first = await rpc('hyve', probe);
        const second = await rpc('hyve', probe);

        expect(first.headers['x-blockdust-rpc-cache']).toBe('MISS');
        expect(second.headers['x-blockdust-rpc-cache']).toBe('HIT');
        // Second request never reached upstream.
        expect(calls).toHaveLength(1);
    });

    it('does not cache writes', async () => {
        const calls = stubUpstream();
        const raw = call('eth_sendRawTransaction', ['0xdeadbeef']);
        await rpc('hyve', raw);
        await rpc('hyve', raw);

        // Both must be forwarded; caching a broadcast would drop a transaction.
        expect(calls).toHaveLength(2);
    });

    it('falls back to the explorer endpoint when the primary read fails', async () => {
        let attempt = 0;
        const calls = stubUpstream(() => {
            attempt += 1;
            if (attempt === 1) throw new Error('ECONNREFUSED');
            return {
                ok: true,
                status: 200,
                headers: new Map([['content-type', 'application/json']]),
                text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2' }),
            };
        });

        const res = await rpc('hyve', call('eth_getLogs', [{}]));

        expect(res.status).toBe(200);
        expect(calls).toHaveLength(2);
        expect(calls[1].url).toContain('explorer');
    });

    it('does not fail a write over to a fallback endpoint', async () => {
        const calls = stubUpstream(() => { throw new Error('down'); });
        const res = await rpc('hyve', call('eth_sendRawTransaction', ['0xabc']));

        // Re-broadcasting to a second endpoint risks a double send.
        expect(calls).toHaveLength(1);
        expect(res.status).toBe(502);
    });

    it('reports 502 when every endpoint is unreachable', async () => {
        stubUpstream(() => { throw new Error('unreachable'); });
        const res = await rpc('vitruveo', call('eth_blockNumber'));

        expect(res.status).toBe(502);
        expect(res.body.error).toMatch(/upstream unavailable/i);
    });

    it('preserves the caller request id on a cached response', async () => {
        stubUpstream(() => ({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/json']]),
            text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x7' }),
        }));

        await rpc('vitruveo', { jsonrpc: '2.0', id: 111, method: 'eth_chainId', params: [] });
        const second = await rpc('vitruveo', { jsonrpc: '2.0', id: 222, method: 'eth_chainId', params: [] });

        expect(second.headers['x-blockdust-rpc-cache']).toBe('HIT');
        // A cached body carrying a stale id would desync ethers' request map.
        expect(JSON.parse(second.text).id).toBe(222);
    });
});

describe('/api/ipfs gateway', () => {
    it('rejects an unknown namespace', async () => {
        stubUpstream();
        const res = await request(app).get('/api/ipfs/http/example.com');
        expect(res.status).toBe(400);
    });

    it('rejects path traversal attempts', async () => {
        const calls = stubUpstream();
        const res = await request(app).get('/api/ipfs/ipfs/..%2F..%2Fetc%2Fpasswd');

        expect(res.status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('proxies a valid ipfs cid to a public gateway', async () => {
        const calls = stubUpstream(() => ({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/json']]),
            body: null,
            arrayBuffer: async () => new TextEncoder().encode('{"name":"x"}').buffer,
            text: async () => '{"name":"x"}',
        }));

        await request(app).get('/api/ipfs/ipfs/QmTest123');
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0].url).toContain('QmTest123');
    });
});

describe('/api/health', () => {
    it('returns a JSON snapshot when asked for json', async () => {
        // The route content-negotiates: a browser Accept header gets the HTML
        // status page, so machine callers must ask for json explicitly.
        stubUpstream(() => ({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/json']]),
            text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1ea7' }),
            json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1ea7' }),
        }));

        const res = await request(app).get('/api/health?format=json');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            db: true,
            status: expect.any(String),
            services: expect.any(Array),
        });
        expect(res.headers['cache-control']).toContain('no-store');
    });

    it('renders the HTML status page for browser requests', async () => {
        stubUpstream(() => ({
            ok: true,
            status: 200,
            headers: new Map([['content-type', 'application/json']]),
            text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1ea7' }),
            json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1ea7' }),
        }));

        const res = await request(app).get('/api/health').set('Accept', 'text/html');

        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/html/);
        expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    });
});
