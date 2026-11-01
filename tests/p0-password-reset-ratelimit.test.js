/**
 * Password-reset throttling.
 *
 * Rate limiting is off under NODE_ENV=test (see RATE_LIMIT_ENABLED in
 * src/config/env.js), so this file turns it on before the harness pins the
 * environment.
 *
 * EVERY import that reaches src/config/env.js -- directly or through the
 * harness -- must be dynamic. `import` declarations are hoisted above the
 * assignments below, so a static `import ... from './helpers/harness.js'` would
 * be evaluated first, read RATE_LIMIT_ENABLED before it is set, freeze the
 * limiter as disabled, and make every assertion here pass vacuously. Only
 * modules that never touch application config may be imported statically.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

process.env.RATE_LIMIT_ENABLED = 'true';
process.env.RESET_RATE_IP_MAX = '4';
process.env.RESET_RATE_IP_WINDOW_MS = '60000';
// High enough that the per-account bucket never interferes with the IP case.
process.env.RESET_RATE_ACCOUNT_MAX = '100';

const { createApiClient, isError } = await import('./helpers/api.js');
const { closePool, resetDatabase, startServer } = await import('./helpers/harness.js');

// Proves the environment was actually pinned before env.js was read: if this is
// false, the limiters are disabled and the tests below prove nothing.
const { env } = await import('../src/config/env.js');
assert.equal(env.isRateLimitEnabled, true, 'rate limiting must be enabled for this file');

let server;

before(async () => {
  await resetDatabase();
  server = await startServer();
});

after(async () => {
  await server.close();
  await closePool();
});

function anon() {
  return createApiClient(server.baseUrl);
}

describe('password-reset rate limiting', () => {
  it('stops a flood from one address', async () => {
    const client = anon();
    const statuses = [];

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await client.post('/api/auth/forgot-password', {
        email: `flood-${attempt}@stockpulse.test`,
      });
      statuses.push(response.status);
      if (response.status === 429) {
        assert.ok(isError(response, 'RATE_LIMITED'));
        // The throttle must not become an oracle either: it says nothing about
        // whether any of the addresses tried actually exist.
        assert.ok(!/exist/i.test(response.body.error.message));
        return;
      }
    }

    assert.fail(`expected a 429 within 6 attempts, saw ${statuses.join(', ')}`);
  });

  it('throttles repeated link checks', async () => {
    const client = anon();
    let limited = null;

    for (let attempt = 0; attempt < 25 && !limited; attempt += 1) {
      const response = await client.post('/api/auth/validate-reset-token', {
        token: 'a'.repeat(64),
      });
      if (response.status === 429) limited = response;
    }

    assert.ok(limited, 'expected the attempt limiter to engage');
    assert.ok(isError(limited, 'RATE_LIMITED'));
  });
});
