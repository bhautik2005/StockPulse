/**
 * Password reset: request, validate, consume.
 *
 * These tests drive the real HTTP surface -- cookies, CSRF, rate limiting, the
 * migration-applied schema -- rather than the service functions, because the
 * properties that matter here (single use, no session, no enumeration) are
 * properties of the whole path.
 *
 * The mail transport is Nodemailer's JSON transport under NODE_ENV=test, so the
 * suite never contacts a network; `outbox` receives what would have been sent.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { createApiClient, isError } from './helpers/api.js';
import { createUser, createWorld, uniqueKey } from './helpers/fixtures.js';
import { bootstrapAdmin, closePool, query, resetDatabase, startServer } from './helpers/harness.js';

// Imported dynamically so it is evaluated *after* the harness has pinned
// NODE_ENV=test; a static import could be hoisted above that assignment.
const { outbox, resetOutbox } = await import('../src/lib/mailer.js');

const GENERIC_MESSAGE =
  'If an account exists with this email address, you will receive a reset link shortly.';
const NEW_PASSWORD = 'BrandNewPass1234!';

let server;
let world;

before(async () => {
  await resetDatabase();
  server = await startServer();
  world = await createWorld(server.baseUrl);
});

after(async () => {
  await server.close();
  await closePool();
});

/** A fresh anonymous client, i.e. someone who cannot sign in. */
function anon() {
  return createApiClient(server.baseUrl);
}

/** The mailer dispatches without blocking, so tests wait for the side effect. */
async function waitForMail(predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = [...outbox].reverse().find(predicate);
    if (found) return found;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** Gives an in-flight background send time to land before asserting absence. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 80));
}

function tokenFrom(mail) {
  const match = /\/reset-password\?token=([a-f0-9]{64})/.exec(mail?.text ?? '');
  return match?.[1] ?? null;
}

/** Requests a link and returns the raw token from the delivered email. */
async function requestReset(email) {
  const client = anon();
  const response = await client.post('/api/auth/forgot-password', { email });
  const mail = await waitForMail((message) => message.to === email);
  return { response, mail, token: tokenFrom(mail) };
}

async function userIdFor(email) {
  const { rows } = await query('SELECT id FROM users WHERE lower(email) = lower($1)', [email]);
  return rows[0]?.id;
}

async function tokensFor(userId) {
  const { rows } = await query(
    `SELECT id, token_hash, expires_at, used_at
       FROM password_reset_tokens
      WHERE user_id = $1
      ORDER BY id`,
    [userId],
  );
  return rows;
}

describe('POST /api/auth/forgot-password', () => {
  before(() => resetOutbox());

  it('accepts a request and replies with the generic message', async () => {
    resetOutbox();
    const { response, token } = await requestReset(world.clients.acme.email);

    assert.equal(response.status, 200);
    assert.equal(response.body.message, GENERIC_MESSAGE);
    assert.ok(token, 'the reset email should carry a token');
  });

  it('replies identically for an address that has no account', async () => {
    resetOutbox();
    const response = await anon().post('/api/auth/forgot-password', {
      email: `nobody-${uniqueKey()}@nowhere.test`,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.message, GENERIC_MESSAGE);

    await settle();
    assert.equal(outbox.length, 0, 'no mail may be sent to an unknown address');
  });

  it('replies identically for a disabled account, and sends nothing', async () => {
    resetOutbox();
    const disabled = await createUser(world.admin.api, {
      role: 'Staff',
      email: `disabled-${uniqueKey()}@stockpulse.test`,
    });
    await world.admin.api.patch(`/api/users/${disabled.id}`, { is_active: false });

    const response = await anon().post('/api/auth/forgot-password', { email: disabled.email });

    assert.equal(response.status, 200);
    assert.equal(response.body.message, GENERIC_MESSAGE);

    await settle();
    assert.equal(outbox.length, 0, 'a disabled account must not receive a link');
    assert.equal((await tokensFor(disabled.id)).length, 0, 'and none may be stored');
  });

  it('never stores the raw token, only its SHA-256 digest', async () => {
    resetOutbox();
    const { token } = await requestReset(world.clients.globex.email);
    const userId = await userIdFor(world.clients.globex.email);
    const rows = await tokensFor(userId);

    assert.equal(rows.length, 1);
    assert.match(rows[0].token_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(rows[0].token_hash, token);
    assert.equal(rows[0].token_hash, createHash('sha256').update(token).digest('hex'));
  });

  it('builds the link from FRONTEND_URL, ignoring a spoofed X-Forwarded-Host', async () => {
    resetOutbox();
    const client = anon();
    await client.post(
      '/api/auth/forgot-password',
      { email: world.clients.acme.email },
      { headers: { 'x-forwarded-host': 'evil.example.com' } },
    );

    const mail = await waitForMail((message) => message.to === world.clients.acme.email);
    assert.ok(mail, 'expected a reset email');
    assert.ok(
      mail.text.includes('http://localhost:5173/reset-password?token='),
      'the link must come from configuration, not from a request header',
    );
    assert.ok(!mail.text.includes('evil.example.com'));
  });

  it('retires the previous link when a new one is requested', async () => {
    resetOutbox();
    const first = await requestReset(world.staff.nairobi.email);
    await settle();
    resetOutbox();
    const second = await requestReset(world.staff.nairobi.email);

    assert.ok(first.token && second.token);
    assert.notEqual(first.token, second.token);

    // The older link is dead, the newer one still works.
    const old = await anon().post('/api/auth/validate-reset-token', { token: first.token });
    const fresh = await anon().post('/api/auth/validate-reset-token', { token: second.token });
    assert.equal(old.body.valid, false);
    assert.equal(fresh.body.valid, true);
  });

  it('rejects a missing email with a validation error', async () => {
    const response = await anon().post('/api/auth/forgot-password', {});
    assert.equal(response.status, 422);
    assert.ok(isError(response, 'VALIDATION_FAILED'));
  });
});

describe('POST /api/auth/validate-reset-token', () => {
  it('reports a fresh token as valid', async () => {
    resetOutbox();
    const { token } = await requestReset(world.clients.acme.email);
    const response = await anon().post('/api/auth/validate-reset-token', { token });

    assert.equal(response.status, 200);
    assert.equal(response.body.valid, true);
  });

  it('does not consume the token', async () => {
    resetOutbox();
    const { token } = await requestReset(world.clients.acme.email);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await anon().post('/api/auth/validate-reset-token', { token });
      assert.equal(response.body.valid, true, 'checking a link must not spend it');
    }
  });

  it('rejects a missing token as a validation error', async () => {
    // An absent token never reaches the API from the SPA (the page shows the
    // invalid state without calling), so treating it as malformed input --
    // rather than as a token that merely failed to match -- is both accurate
    // and consistent with the rest of the API's required fields.
    for (const body of [{}, { token: '' }, { token: '   ' }]) {
      const response = await anon().post('/api/auth/validate-reset-token', body);
      assert.equal(response.status, 422);
      assert.ok(isError(response, 'VALIDATION_FAILED'));
    }
  });

  it('reports a malformed token as invalid rather than failing', async () => {
    for (const token of ['not-a-token', 'x'.repeat(64), "'; DROP TABLE users; --"]) {
      const response = await anon().post('/api/auth/validate-reset-token', { token });
      assert.equal(response.status, 200, `token ${JSON.stringify(token)} should not error`);
      assert.equal(response.body.valid, false);
    }
  });

  it('reports an unknown but well-formed token as invalid', async () => {
    const response = await anon().post('/api/auth/validate-reset-token', {
      token: randomBytes(32).toString('hex'),
    });
    assert.equal(response.body.valid, false);
  });

  it('reports an expired token as invalid', async () => {
    const email = `expired-${uniqueKey()}@stockpulse.test`;
    const user = await createUser(world.admin.api, { role: 'Staff', email });

    const raw = randomBytes(32).toString('hex');
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() - interval '1 minute')`,
      [user.id, createHash('sha256').update(raw).digest('hex')],
    );

    const response = await anon().post('/api/auth/validate-reset-token', { token: raw });
    assert.equal(response.body.valid, false);
  });

  it('leaves the users table intact after an injection-shaped token', async () => {
    const before = await query('SELECT count(*)::int AS total FROM users');
    await anon().post('/api/auth/validate-reset-token', { token: "'; DROP TABLE users; --" });
    const after = await query('SELECT count(*)::int AS total FROM users');
    assert.equal(after.rows[0].total, before.rows[0].total);
  });
});

describe('POST /api/auth/reset-password', () => {
  it('replaces the password, and the new one signs in', async () => {
    resetOutbox();
    const { token } = await requestReset(world.clients.globex.email);

    const response = await anon().post('/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    assert.equal(response.status, 200);

    const fresh = anon();
    const signedIn = await fresh.login(world.clients.globex.email, NEW_PASSWORD);
    assert.equal(signedIn.status, 200);

    const stale = anon();
    const rejected = await stale.login(world.clients.globex.email, world.clients.globex.password);
    assert.equal(rejected.status, 401);
    assert.ok(isError(rejected, 'INVALID_CREDENTIALS'));
  });

  it('does not create a session', async () => {
    resetOutbox();
    const { token } = await requestReset(world.clients.acme.email);

    const response = await anon().post('/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.token, undefined, 'no access token may be returned');
    const setCookie = response.headers.getSetCookie?.() ?? [];
    assert.equal(
      setCookie.filter((cookie) => cookie.startsWith('sp_token=')).length,
      0,
      'no session cookie may be set',
    );
  });

  it('burns the token: a second use is rejected', async () => {
    resetOutbox();
    const { token } = await requestReset(world.staff.nairobi.email);

    const first = await anon().post('/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    const second = await anon().post('/api/auth/reset-password', {
      token,
      password: 'AnotherPass12345!',
      confirmPassword: 'AnotherPass12345!',
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 400);
    assert.ok(isError(second, 'INVALID_RESET_TOKEN'));
  });

  it('lets exactly one of two concurrent submissions win', async () => {
    resetOutbox();
    const email = `race-${uniqueKey()}@stockpulse.test`;
    await createUser(world.admin.api, { role: 'Staff', email });
    const { token } = await requestReset(email);

    const payload = { token, password: NEW_PASSWORD, confirmPassword: NEW_PASSWORD };
    const results = await Promise.all([
      anon().post('/api/auth/reset-password', payload),
      anon().post('/api/auth/reset-password', payload),
    ]);

    const statuses = results.map((result) => result.status).sort();
    assert.deepEqual(statuses, [200, 400], 'the conditional UPDATE must admit one winner');
  });

  it('revokes existing sessions', async () => {
    resetOutbox();
    const email = `revoke-${uniqueKey()}@stockpulse.test`;
    const user = await createUser(world.admin.api, { role: 'Staff', email });

    const session = anon();
    const signedIn = await session.login(user.email, user.password);
    assert.equal(signedIn.status, 200);
    assert.equal((await session.get('/api/auth/me')).status, 200);

    const { token } = await requestReset(email);
    await anon().post('/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });

    const after = await session.get('/api/auth/me');
    assert.equal(after.status, 401, 'the pre-reset session must no longer work');
  });

  it('sends a password-changed notification to the account owner', async () => {
    resetOutbox();
    const email = `notify-${uniqueKey()}@stockpulse.test`;
    await createUser(world.admin.api, { role: 'Staff', email });
    const { token } = await requestReset(email);

    await anon().post('/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });

    const notice = await waitForMail(
      (message) => message.to === email && /password was changed/i.test(message.subject),
    );
    assert.ok(notice, 'a confirmation email should be sent');
    assert.ok(!notice.text.includes(NEW_PASSWORD), 'the email must not contain the password');
    assert.ok(!notice.text.includes(token), 'nor the token');
  });

  it('refuses a token minted before the account was disabled, and does not reactivate it', async () => {
    const email = `late-disabled-${uniqueKey()}@stockpulse.test`;
    const user = await createUser(world.admin.api, { role: 'Staff', email });

    // A link that existed while the account was still enabled.
    const raw = randomBytes(32).toString('hex');
    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [user.id, createHash('sha256').update(raw).digest('hex')],
    );

    await world.admin.api.patch(`/api/users/${user.id}`, { is_active: false });

    const response = await anon().post('/api/auth/reset-password', {
      token: raw,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });

    assert.equal(response.status, 400);
    assert.ok(isError(response, 'INVALID_RESET_TOKEN'));

    const { rows } = await query('SELECT is_active, password_hash FROM users WHERE id = $1', [user.id]);
    assert.equal(rows[0].is_active, false, 'a reset must never re-enable an account');

    const login = await anon().login(email, NEW_PASSWORD);
    assert.equal(login.status, 401, 'the password must not have changed either');
  });

  it('changes nothing but the password: role and warehouse grants are untouched', async () => {
    const manager = world.managers.lagos;

    const grantsBefore = await query(
      'SELECT warehouse_id FROM user_warehouses WHERE user_id = $1 ORDER BY warehouse_id',
      [manager.id],
    );

    const { token } = await requestReset(manager.email);
    const response = await anon().post('/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD,
      confirmPassword: NEW_PASSWORD,
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.data.role, 'Manager');

    const { rows } = await query('SELECT role, is_active FROM users WHERE id = $1', [manager.id]);
    assert.equal(rows[0].role, 'Manager');
    assert.equal(rows[0].is_active, true);

    const grantsAfter = await query(
      'SELECT warehouse_id FROM user_warehouses WHERE user_id = $1 ORDER BY warehouse_id',
      [manager.id],
    );
    assert.deepEqual(grantsAfter.rows, grantsBefore.rows);
  });

  it('rejects a password shorter than the policy minimum', async () => {
    resetOutbox();
    const { token } = await requestReset(world.clients.acme.email);

    const response = await anon().post('/api/auth/reset-password', {
      token,
      password: 'Short1234',
      confirmPassword: 'Short1234',
    });

    assert.equal(response.status, 422);
    assert.ok(isError(response, 'VALIDATION_FAILED'));

    // The link must survive a rejected attempt.
    const check = await anon().post('/api/auth/validate-reset-token', { token });
    assert.equal(check.body.valid, true);
  });

  it('rejects a mismatched confirmation against the confirm field', async () => {
    resetOutbox();
    const { token } = await requestReset(world.clients.acme.email);

    const response = await anon().post('/api/auth/reset-password', {
      token,
      password: NEW_PASSWORD,
      confirmPassword: 'DifferentPass1234!',
    });

    assert.equal(response.status, 422);
    const paths = (response.body.error.details ?? []).map((issue) => issue.path);
    assert.ok(paths.includes('confirmPassword'), `expected a confirmPassword error, got ${paths}`);
  });

  it('rejects a malformed token without a 500', async () => {
    for (const token of ['', 'nope', randomBytes(32).toString('hex'), "'; DROP TABLE users; --"]) {
      const response = await anon().post('/api/auth/reset-password', {
        token,
        password: NEW_PASSWORD,
        confirmPassword: NEW_PASSWORD,
      });
      assert.ok(
        response.status === 400 || response.status === 422,
        `expected a client error for ${JSON.stringify(token)}, got ${response.status}`,
      );
      assert.notEqual(response.status, 500);
    }
  });
});

describe('reset-token schema', () => {
  it('cascades token rows away with the user', async () => {
    const email = `cascade-${uniqueKey()}@stockpulse.test`;
    const user = await createUser(world.admin.api, { role: 'Staff', email });

    const row = await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes') RETURNING id`,
      [user.id, randomBytes(32).toString('hex')],
    );

    // A hard delete is not something the API exposes, so this asserts the FK
    // action itself: the token table must never be the reason a user cannot go.
    await query('DELETE FROM users WHERE id = $1', [user.id]);

    const { rows } = await query('SELECT id FROM password_reset_tokens WHERE id = $1', [row.rows[0].id]);
    assert.equal(rows.length, 0);
  });

  it('refuses to store two rows with the same hash', async () => {
    const email = `uniq-${uniqueKey()}@stockpulse.test`;
    const user = await createUser(world.admin.api, { role: 'Staff', email });
    const hash = randomBytes(32).toString('hex');

    await query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 minutes')`,
      [user.id, hash],
    );

    await assert.rejects(
      () =>
        query(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + interval '30 minutes')`,
          [user.id, hash],
        ),
      (error) => error.code === '23505',
    );
  });
});

describe('anti-enumeration', () => {
  it('takes a comparable amount of time for a real and an unknown address', async () => {
    resetOutbox();

    const measure = async (email) => {
      const client = anon();
      const started = process.hrtime.bigint();
      await client.post('/api/auth/forgot-password', { email });
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    // Warm up so first-call module/JIT costs do not land on only one sample.
    await measure(world.clients.acme.email);
    await measure(`warmup-${uniqueKey()}@nowhere.test`);

    const real = [];
    const fake = [];
    for (let index = 0; index < 5; index += 1) {
      real.push(await measure(world.clients.acme.email));
      fake.push(await measure(`absent-${uniqueKey()}@nowhere.test`));
    }

    const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;
    const ratio = mean(real) / mean(fake);

    // Loose by necessity: a timing assertion that is tight enough to be
    // meaningful on one machine fails on the next. What this catches is the
    // regression that matters -- awaiting the SMTP round-trip on the real path
    // would push this ratio well past 2.
    assert.ok(
      ratio > 0.5 && ratio < 2.5,
      `response time ratio ${ratio.toFixed(2)} suggests account enumeration`,
    );
  });
});
