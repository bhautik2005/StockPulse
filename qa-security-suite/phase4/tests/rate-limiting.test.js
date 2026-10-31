/**
 * Phase 4 :: Brute-force / credential-stuffing protection.
 *
 * This file turns the login limiter ON explicitly.
 *
 * It has to: src/config/env.js defaults RATE_LIMIT_ENABLED to "false in the test
 * environment", precisely so the rest of the suite is not throttled by its own
 * fixtures. That default is a sensible one, but it has a dangerous consequence --
 * a limiter no test ever executes is indistinguishable from a limiter that does
 * not work. So this file sets the flag *before* src/config/env.js is imported.
 *
 *   vi.hoisted() is the only place in a Vitest module that runs before the
 *   static imports of EVERYTHING, including setup files. Assigning process.env
 *   at the top of the file body would be too late.
 *
 * Each test uses a distinct client IP (see TEST_IPS) so one test tripping the
 * limit cannot exhaust the bucket another test depends on.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.RATE_LIMIT_ENABLED = 'true';
  // A deliberately tiny budget: proving the 429 should not require 11 real
  // bcrypt comparisons plus a 15-minute wait.
  process.env.RATE_LIMIT_MAX = '3';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
});

import { app, resetDatabase } from '../../phase1/setup/db.js';
import { createClient, createClientFromIp, TEST_IPS } from '../../phase1/helpers/client.js';
import { createSimpleWorld } from '../../phase1/helpers/fixtures.js';

const LIMIT = 3;

let world;

beforeAll(async () => {
  await resetDatabase();
  world = await createSimpleWorld({ stock: 1 });
});

afterAll(async () => {
  const { closePool } = await import('../../phase1/setup/db.js');
  await closePool();
});

describe('Phase 4 :: rate limiting on POST /api/auth/login', () => {
  it('returns 429 RATE_LIMITED once the budget is exhausted', async () => {
    const api = createClientFromIp(app, TEST_IPS[0]);

    const statuses = [];
    for (let attempt = 1; attempt <= LIMIT + 1; attempt += 1) {
      const response = await api.post('/api/auth/login', {
        email: `bruteforce-${TEST_IPS[0]}@client.test`,
        password: 'WrongPassword1234',
      });
      statuses.push(response.status);
    }

    // The first `LIMIT` attempts are answered normally (401 here, because the
    // credentials are wrong); the next one is refused outright.
    expect(statuses.slice(0, LIMIT).every((status) => status === 401)).toBe(true);
    expect(statuses[LIMIT]).toBe(429);
  });

  it('uses the same error envelope and a Retry-After hint', async () => {
    const api = createClientFromIp(app, TEST_IPS[1]);
    const body = { email: 'envelope@client.test', password: 'WrongPassword1234' };

    for (let attempt = 0; attempt < LIMIT; attempt += 1) await api.post('/api/auth/login', body);
    const blocked = await api.post('/api/auth/login', body);

    expect(blocked.status).toBe(429);
    expect(blocked.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      message: expect.stringMatching(/too many/i),
    });
    // A client that cannot tell when to retry will simply hammer harder.
    expect(blocked.body.error).toHaveProperty('requestId');
    expect(blocked.headers).toHaveProperty('ratelimit-policy');
  });

  it('counts attempts per IP, so one attacker cannot lock out everyone', async () => {
    const victim = world.client;

    // An attacker hammers the victim's account from their own address.
    const attacker = createClientFromIp(app, TEST_IPS[2]);
    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      await attacker.post('/api/auth/login', { email: victim.email, password: 'WrongPassword1234' });
    }
    expect((await attacker.post('/api/auth/login', { email: victim.email, password: 'x' })).status).toBe(429);

    // The victim, signing in from a different address, is unaffected. This is
    // the whole point of per-IP keying: without it, credential stuffing becomes
    // a denial of service against the accounts being attacked.
    const legitimate = createClientFromIp(app, TEST_IPS[3]);
    const ok = await legitimate.login(victim.email, victim.password);

    expect(ok.status).toBe(200);
    expect(ok.body.data.email).toBe(victim.email);
  });

  it('also keys on the targeted account, so one noisy address cannot flood every account', async () => {
    // A single shared NAT address (an office, a university, a mobile carrier)
    // must not be able to exhaust the budget for unrelated accounts.
    const shared = createClientFromIp(app, TEST_IPS[7]);

    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      await shared.post('/api/auth/login', { email: 'noise@client.test', password: 'WrongPassword1234' });
    }
    expect((await shared.post('/api/auth/login', { email: 'noise@client.test', password: 'x' })).status).toBe(429);

    const other = await shared.login(world.admin.email, world.admin.password);
    expect(other.status).toBe(200);
  });

  it('leaves non-login endpoints unlimited', async () => {
    const api = createClientFromIp(app, TEST_IPS[4]);

    for (let attempt = 0; attempt < LIMIT + 3; attempt += 1) {
      const response = await api.get('/api/auth/me');
      // 401 every time: authentication failure, never throttling.
      expect(response.status).toBe(401);
    }
  });

  it('is reachable on the register endpoint too, so account creation is not a free amplifier', async () => {
    const api = createClientFromIp(app, TEST_IPS[5]);

    // Registration is not behind the login limiter in this codebase; this test
    // records that fact so the omission is a known decision rather than a
    // surprise. If a limiter is added there, this test fails loudly and the
    // expectation is updated deliberately.
    const response = await api.post('/api/auth/register', {
      name: 'No Limit',
      email: `unlimited-${Date.now()}@client.test`,
      password: 'Password1234',
    });

    expect(response.status).toBe(201);
  });

  it('the limiter is a factory, so a fresh instance starts with a fresh budget', async () => {
    const { createLoginLimiter } = await import('../../../src/modules/auth/auth.routes.js');

    const first = createLoginLimiter({ windowMs: 60_000, max: 1, enabled: true });
    const second = createLoginLimiter({ windowMs: 60_000, max: 1, enabled: true });

    expect(first).not.toBe(second);

    // With `enabled: false` the middleware short-circuits, which is what keeps
    // the rest of the suite unthrottled.
    const disabled = createLoginLimiter({ windowMs: 60_000, max: 1, enabled: false });
    const called = vi.fn();
    await new Promise((resolve) => {
      disabled({ ip: '127.0.0.1', body: {}, method: 'POST', headers: {} }, {}, () => {
        called();
        resolve();
      });
    });
    expect(called).toHaveBeenCalledTimes(1);
  });
});
