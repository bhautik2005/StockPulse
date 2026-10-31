/**
 * Phase 4 :: Strict CORS and security headers.
 *
 * CORS with `credentials: true` is one of the few places where a small
 * configuration mistake is a full account-takeover primitive: reflecting an
 * arbitrary Origin while allowing credentials lets any website read
 * authenticated responses. So these tests are written as an attacker would probe
 * it, with a positive case for every negative one.
 *
 * The rules under test (src/app.js):
 *   - an origin in CORS_ORIGIN                    -> echoed
 *   - any *.vercel.app preview deployment         -> echoed
 *   - an attacker's origin                        -> refused
 *   - `null` origin (sandboxed iframe / file://)  -> refused
 *   - a missing Origin (curl, server-to-server)   -> allowed, because no browser
 *                                                    is involved and no ambient
 *                                                    credential can be abused
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app, env, resetDatabase } from '../../phase1/setup/db.js';
import { createClient } from '../../phase1/helpers/client.js';
import { createSimpleWorld } from '../../phase1/helpers/fixtures.js';

let world;

const configuredOrigin = () => env.CORS_ORIGIN.split(',')[0].trim();

beforeAll(async () => {
  await resetDatabase();
  world = await createSimpleWorld({ stock: 5 });
});

afterAll(async () => {
  const { closePool } = await import('../../phase1/setup/db.js');
  await closePool();
});

function preflight(origin, { method = 'POST', requestHeaders = 'content-type,x-csrf-token' } = {}) {
  const api = createClient(app);
  return api.options('/api/orders', {
    headers: {
      origin,
      'access-control-request-method': method,
      'access-control-request-headers': requestHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Allowed origins
// ---------------------------------------------------------------------------

describe('Phase 4 :: CORS allows the configured frontend', () => {
  it('echoes the exact configured origin', async () => {
    const origin = configuredOrigin();
    const response = await preflight(origin);

    expect(response.status).toBeLessThan(300);
    expect(response.headers['access-control-allow-origin']).toBe(origin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('allows any vercel.app preview deployment', async () => {
    const previews = [
      'https://stockpulse-git-feature-x-acme.vercel.app',
      'https://stockpulse-9f3kd2.vercel.app',
    ];

    for (const origin of previews) {
      const response = await preflight(origin);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    }
  });

  it('advertises the methods and headers the SPA actually needs', async () => {
    const response = await preflight(configuredOrigin());
    const allowedHeaders = String(response.headers['access-control-allow-headers'] ?? '').toLowerCase();

    expect(String(response.headers['access-control-allow-methods'])).toMatch(/POST/);
    expect(String(response.headers['access-control-allow-methods'])).toMatch(/PATCH/);
    // Without X-CSRF-Token in the preflight response, every cookie-authenticated
    // mutation from the SPA fails in the browser before it is even sent.
    expect(allowedHeaders).toContain('x-csrf-token');
    expect(allowedHeaders).toContain('content-type');
    expect(String(response.headers['access-control-expose-headers'])).toMatch(/x-request-id/i);
  });

  it('caches the preflight instead of re-asking on every request', async () => {
    const response = await preflight(configuredOrigin());
    expect(Number(response.headers['access-control-max-age'])).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Refused origins
// ---------------------------------------------------------------------------

describe('Phase 4 :: CORS refuses everyone else', () => {
  it('does not reflect an attacker origin', async () => {
    const response = await preflight('https://evil.example.com');

    const allowed = response.headers['access-control-allow-origin'];
    expect(allowed).not.toBe('https://evil.example.com');
    expect(allowed).not.toBe('*');
    // With credentials in play, a wildcard is worse than useless: the browser
    // rejects it, so the failure surfaces as an inexplicable CORS error.
    expect(response.headers['access-control-allow-credentials']).not.toBe('true');
  });

  it('refuses an origin that merely looks like a vercel.app domain', async () => {
    const impostors = [
      'https://vercel.app.evil.example.com',
      'https://notvercel.app',
      'http://stockpulse.vercel.app.evil.example.com',
    ];

    for (const origin of impostors) {
      const response = await preflight(origin);
      expect(response.headers['access-control-allow-origin']).not.toBe(origin);
    }
  });

  it('refuses a subdomain of an allowed origin', async () => {
    // `endsWith('.vercel.app')` is intentionally limited to that suffix; an
    // attacker-registered subdomain of your own domain is not automatically safe.
    const response = await preflight('https://preview.stockpulse.example.com');
    expect(response.headers['access-control-allow-origin']).not.toBe('https://preview.stockpulse.example.com');
  });

  it('refuses the "null" origin used by sandboxed iframes and file:// pages', async () => {
    const response = await preflight('null');
    expect(response.headers['access-control-allow-origin']).not.toBe('null');
  });

  it('never answers with a wildcard while credentials are enabled', async () => {
    for (const origin of ['https://evil.example.com', 'null', configuredOrigin()]) {
      const response = await preflight(origin);
      expect(response.headers['access-control-allow-origin']).not.toBe('*');
    }
  });

  it('still refuses a disallowed origin on a real (non-preflight) request', async () => {
    const api = createClient(app);
    const response = await api.post(
      '/api/auth/login',
      { email: 'nobody@client.test', password: 'Password1234' },
      { headers: { origin: 'https://evil.example.com' } },
    );

    // The request is processed (the browser is what blocks the *response*), but
    // the response must not carry a CORS grant that would let the attacker read it.
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------

describe('Phase 4 :: security headers (helmet)', () => {
  it('sets the baseline hardening headers', async () => {
    const api = createClient(app);
    const response = await api.get('/api');
    const headers = response.headers;

    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['referrer-policy']).toBeDefined();
    expect(headers['content-security-policy']).toBeDefined();
    expect(headers['strict-transport-security']).toBeDefined();
    expect(headers['cross-origin-opener-policy']).toBeDefined();
    expect(headers['cross-origin-resource-policy']).toBeDefined();
  });

  it('hides the server technology', async () => {
    const api = createClient(app);
    const response = await api.get('/health');

    // `app.disable('x-powered-by')` plus helmet: an unnecessary fingerprint.
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('disables frame embedding, so the console cannot be clickjacked', async () => {
    const api = createClient(app);
    const response = await api.get('/api');

    // helmet sets exactly one of these depending on version; both mean "no framing".
    const csp = String(response.headers['content-security-policy'] ?? '');
    const xfo = String(response.headers['x-frame-options'] ?? '');
    expect(csp.includes("frame-ancestors 'none'") || xfo === 'DENY' || xfo === 'SAMEORIGIN').toBe(true);
  });

  it('does not advertise framework internals through an error response', async () => {
    const api = createClient(app);
    const response = await api.get('/definitely-not-a-route');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
    // The route is echoed back, but no stack trace, file path or dependency name.
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toMatch(/at Object\.|node_modules|\.js:\d+:\d+/);
  });

  it('echoes a correlation id, which is what makes an incident debuggable', async () => {
    const api = createClient(app);

    const generated = await api.get('/api');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const supplied = await api.get('/api', { headers: { 'x-request-id': 'trace-me-1234' } });
    expect(supplied.headers['x-request-id']).toBe('trace-me-1234');
  });
});

// ---------------------------------------------------------------------------
// Payload and body-shape limits
// ---------------------------------------------------------------------------

describe('Phase 4 :: request body limits', () => {
  it('rejects an oversized JSON body with 400 rather than buffering it forever', async () => {
    const api = createClient(app);
    const response = await api.post(
      '/api/auth/login',
      { email: 'flood@client.test', password: 'x'.repeat(300 * 1024) },
    );

    // src/app.js caps the JSON parser at 256kb; an unbounded parser is a trivial
    // memory-exhaustion DoS.
    expect([400, 413, 422]).toContain(response.status);
    expect(response.body.error.code).toMatch(/PAYLOAD_TOO_LARGE|VALIDATION_FAILED/);
  });

  it('rejects malformed JSON with 400', async () => {
    const api = createClient(app);
    const response = await api.post('/api/auth/login', '{ not json', {
      headers: { 'content-type': 'application/json' },
    });

    expect(response.status).toBe(400);
  });
});
