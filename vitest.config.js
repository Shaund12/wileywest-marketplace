import { defineConfig } from 'vitest/config';

/**
 * Test layout:
 *   tests/unit/*      pure logic, no I/O (chain registry, pgRestClient shim)
 *   tests/api/*       the Express surface driven through supertest with a
 *                     stubbed pg pool — no live database required
 *   tests/smoke/*     hits a REAL running backend; skipped unless SMOKE_BASE_URL
 *                     is set, so `npm test` stays green on a bare checkout
 *
 * Everything runs in the node environment: the frontend units under test are
 * plain modules, and jsdom would only add a dependency without buying coverage.
 */
export default defineConfig({
    test: {
        environment: 'node',
        include: ['tests/**/*.test.js'],
        globals: false,
        restoreMocks: true,
        clearMocks: true,
        // The API tests mutate module-level rate-limit buckets and env vars, so
        // give each file its own module registry.
        isolate: true,
        // Smoke tests make real network calls (chain RPCs can be slow); the 5s
        // default is too tight and produces confusing timeouts rather than
        // useful assertion failures.
        testTimeout: 30_000,
        hookTimeout: 30_000,
        coverage: {
            provider: 'v8',
            include: ['src/lib/**', 'src/config/**', 'backend/routes/**', 'backend/middleware/**'],
        },
    },
});
