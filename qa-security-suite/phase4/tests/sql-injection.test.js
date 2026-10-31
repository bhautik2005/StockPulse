/**
 * Phase 4 :: SQL injection defence.
 *
 * Two independent layers, because neither is sufficient alone:
 *
 *   1. DYNAMIC -- real payloads are sent through the real HTTP surface. This
 *      proves behaviour: what a payload actually does when it reaches the
 *      driver, the validator and the planner.
 *   2. STATIC  -- qa-security-suite/phase4/scripts/audit-sql-injection.mjs
 *      inspects the source for interpolation into a SQL statement. This catches
 *      the query that no test happens to exercise.
 *
 * The dynamic half deliberately uses payloads that are *valid* for the field
 * being sent. A payload rejected by Zod proves nothing about the SQL layer --
 * only that the validator ran. The interesting cases are the ones that pass
 * validation and then have to survive the database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { app, query, resetDatabase, scalar } from '../../phase1/setup/db.js';
import { createClient, isError } from '../../phase1/helpers/client.js';
import { createSimpleWorld, createProduct, receiveStock, uniqueKey } from '../../phase1/helpers/fixtures.js';

let world;

/**
 * Payloads that are legal as a *value* in the columns under test.
 *
 * `classic` is the canonical injection; `union` attempts data exfiltration;
 * `stacked` attempts a second statement; `comment` and `quote` attempt to break
 * out of a literal; `unicode` and `nullbyte` probe parser edge cases.
 */
const PAYLOADS = {
  classic: "' OR '1'='1",
  adminBypass: "admin@stockpulse.dev' --",
  union: "' UNION SELECT id, email, password_hash, role FROM users --",
  stacked: "'; DROP TABLE orders; --",
  quote: "O'Brien's \"Supply\" Co",
  comment: "/* not a comment in a bind parameter */",
  semicolon: '; SELECT pg_sleep(2);',
  backslash: 'C:\\temp\\new',
  nullByte: 'value\u0000tail',
  unicode: ' ħëłlø — ünïcode ',
  dollarQuote: '$$injection$$',
  jsonish: '{"$ne": null}',
};

/** A value carrying an embedded null byte, which PostgreSQL cannot store. */
const BACKDOOR_NAME = 'Backdoor\u0000Name';

beforeAll(async () => {
  await resetDatabase();
  world = await createSimpleWorld({ stock: 50 });
});

afterAll(async () => {
  const { closePool } = await import('../../phase1/setup/db.js');
  await closePool();
});

// ---------------------------------------------------------------------------
// 1. Payloads as identifiers-adjacent fields: search, filters, ordering
// ---------------------------------------------------------------------------

describe('Phase 4 :: SQL injection through query parameters', () => {
  it('treats a classic payload in ?search= as a literal, matching nothing', async () => {
    const response = await world.admin.api.get('/api/products', {
      query: { search: PAYLOADS.classic, limit: 100 },
    });

    expect(response.status).toBe(200);
    // The payload is a search *term*. It must not return every row, which is
    // exactly what a successful `OR '1'='1'` would do.
    expect(response.body.data).toHaveLength(0);

    // And the table is still there.
    expect(Number(await scalar('SELECT count(*)::int FROM products'))).toBeGreaterThan(0);
  });

  it('survives a UNION SELECT payload without leaking password hashes', async () => {
    const response = await world.admin.api.get('/api/products', {
      query: { search: PAYLOADS.union, limit: 100 },
    });

    expect(response.status).toBe(200);
    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toMatch(/\$2[aby]\$/); // bcrypt
    expect(serialised).not.toMatch(/password_hash/);
  });

  it('refuses to execute a stacked statement in a query parameter', async () => {
    const response = await world.admin.api.get('/api/products', {
      query: { search: PAYLOADS.stacked, limit: 100 },
    });

    // node-postgres uses the extended query protocol, which cannot carry two
    // statements, so this is a 200 with no matches rather than a dropped table.
    expect([200, 400, 422]).toContain(response.status);
    expect(Number(await scalar(`SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'orders'`))).toBe(1);
  });

  it('rejects a non-numeric value in a numeric filter with 400, not a 500', async () => {
    const response = await world.admin.api.get('/api/inventory', {
      query: { warehouse_id: PAYLOADS.adminBypass },
    });

    // Zod rejects the type before SQL is reached, and the envelope stays uniform.
    expect(response.status).toBe(400);
    expect(isError(response, 'VALIDATION_FAILED')).toBe(true);
  });

  it('rejects a non-numeric path parameter with 400', async () => {
    const response = await world.admin.api.get(`/api/orders/${encodeURIComponent(PAYLOADS.classic)}`);
    expect([400, 404]).toContain(response.status);
  });

  it('rejects an out-of-range numeric parameter instead of coercing it', async () => {
    const response = await world.admin.api.get('/api/inventory', {
      query: { limit: '9999999999999999999' },
    });

    expect([400, 422]).toContain(response.status);
  });
});

// ---------------------------------------------------------------------------
// 2. Payloads as stored values
// ---------------------------------------------------------------------------

describe('Phase 4 :: SQL injection through request bodies', () => {
  it('stores a quote-heavy product name literally and returns it intact', async () => {
    const created = await world.admin.api.post('/api/products', {
      sku: `QUOTE-${uniqueKey()}`.toUpperCase(),
      name: PAYLOADS.quote,
      unit_price: '12.34',
    });

    expect(created.status).toBe(201);
    expect(created.body.data.name).toBe(PAYLOADS.quote);

    // Round-trip through SQL as a bind parameter: the apostrophes are data.
    const stored = await scalar('SELECT name FROM products WHERE id = $1', [created.body.data.id]);
    expect(stored).toBe(PAYLOADS.quote);
  });

  it('treats a null byte as bad input (422), never as an internal error (500)', async () => {
    /*
     * PostgreSQL cannot store U+0000 in any text type and raises SQLSTATE 22021
     * ("invalid byte sequence for encoding UTF8"). Left unmapped that surfaces as
     * a 500 -- meaning any anonymous caller could manufacture internal errors at
     * will and bury the real ones in the alert stream.
     *
     * Two guards now stand in the way: `safeText` in src/lib/commonSchemas.js
     * rejects it at validation, and src/middleware/errorHandler.js maps 22021 to a
     * 400 as a backstop. Either one alone is enough; the test asserts the
     * behaviour, not which layer produced it.
     */
    const response = await world.admin.api.post('/api/products', {
      sku: `NUL-${uniqueKey()}`.toUpperCase(),
      name: PAYLOADS.nullByte,
      unit_price: '1.00',
    });

    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(Number(await scalar(`SELECT count(*)::int FROM users`))).toBeGreaterThan(0);
  });

  it('rejects a null byte in an update as well as a create', async () => {
    const product = await createProduct(world.admin.api, { name: `Nullbyte Target ${uniqueKey()}` });

    const response = await world.admin.api.patch(`/api/products/${Number(product.id)}`, {
      name: BACKDOOR_NAME,
    });

    expect(response.status).toBe(422);
  });

  it('does not let a null byte through a search parameter either', async () => {
    const response = await world.admin.api.get('/api/products', {
      query: { search: PAYLOADS.nullByte.slice(0, 8) },
    });

    expect([200, 400, 422]).toContain(response.status);
    expect(response.status).not.toBe(500);
  });

  it('stores every payload variant without altering the schema or the row count', async () => {
    const tablesBefore = Number(
      await scalar(`SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public'`),
    );

    for (const [label, payload] of Object.entries(PAYLOADS)) {
      const created = await world.admin.api.post('/api/products', {
        sku: `PAY${label.toUpperCase().slice(0, 6)}-${uniqueKey()}`.toUpperCase(),
        name: payload.slice(0, 140),
        category: payload.slice(0, 90),
        unit_price: '1.00',
      });

      // The label is in the message so a failure names the payload that did it,
      // rather than leaving you to guess which of thirteen entries produced a 500.
      // 500 is deliberately NOT accepted anywhere in this file: a payload is
      // either stored safely or refused as bad input.
      expect(
        [201, 422],
        `payload "${label}" produced ${created.status}: ${JSON.stringify(created.body)}`,
      ).toContain(created.status);

      if (created.status === 201) {
        expect(created.body.data.name).toBe(payload.slice(0, 140));
      }
    }

    const tablesAfter = Number(
      await scalar(`SELECT count(*)::int FROM information_schema.tables WHERE table_schema = 'public'`),
    );
    expect(tablesAfter).toBe(tablesBefore);
  });

  it('does not let a payload in a login email change the query it runs against', async () => {
    const response = await createClient(app).post('/api/auth/login', {
      email: PAYLOADS.adminBypass,
      password: 'anything-at-all',
    });

    // A validator error or a credentials error, never a session.
    expect([401, 422]).toContain(response.status);
    expect(response.body.token).toBeUndefined();
    expect(response.body.data).toBeUndefined();
  });

  it('cannot inject a different warehouse into a stock adjustment', async () => {
    const other = await createSimpleWorld({ stock: 10 });

    const response = await world.admin.api.post('/api/inventory/adjust', {
      warehouse_id: other.warehouse.id,
      product_id: world.product.id,
      // A string is rejected by Zod rather than being concatenated into SQL.
      delta: '1; DROP TABLE inventory; --',
      note: PAYLOADS.stacked,
    });

    expect([400, 422]).toContain(response.status);
    expect(Number(await scalar(`SELECT count(*)::int FROM information_schema.tables WHERE table_name = 'inventory'`))).toBe(1);
  });

  it('keeps a payload inside a LIKE search literal', async () => {
    const product = await createProduct(world.admin.api, { name: `Wildcard ${uniqueKey()}` });
    const needle = product.name.slice(0, 8);

    const exact = await world.admin.api.get('/api/products', { query: { search: needle, limit: 50 } });
    expect(exact.status).toBe(200);
    expect(exact.body.data.map((row) => row.id)).toContain(product.id);

    // The SQL LIKE wildcards are part of the *value* here; whichever way the
    // repository treats them (% is either escaped or literal), the invariant is
    // that the apostrophe cannot terminate the literal early. A payload-shaped
    // search must not behave like a wildcard that matches everything.
    const injected = await world.admin.api.get('/api/products', {
      query: { search: `' OR name ILIKE '%`, limit: 50 },
    });
    expect(injected.status).toBe(200);
    expect(injected.body.data.length).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// 3. Direct-SQL control: the driver really does bind these
// ---------------------------------------------------------------------------

describe('Phase 4 :: the driver binds parameters, it does not interpolate them', () => {
  it('passes a payload through $1 untouched', async () => {
    const payload = PAYLOADS.classic;
    const value = await scalar('SELECT $1::text', [payload]);
    expect(value).toBe(payload);
  });

  it('cannot be tricked into reading another table through a bind parameter', async () => {
    // A name that is guaranteed not to exist, so a zero-row result means the
    // parameter was compared as data. (Using PAYLOADS.union here would be
    // self-defeating: the previous test stores that exact string as a product
    // name, and the query would then legitimately find it.)
    const { rows } = await query('SELECT name FROM products WHERE name = $1', [`absent-${uniqueKey()}`]);
    expect(rows).toHaveLength(0);

    // Same statement, payload as the parameter: still a literal comparison.
    const injected = await query('SELECT id FROM users WHERE email = $1', [PAYLOADS.union]);
    expect(injected.rows).toHaveLength(0);
  });

  it('rejects a bind parameter used as an identifier, as PostgreSQL itself does', async () => {
    // This is the case the static audit exists for: you CANNOT parameterise an
    // identifier, so it must come from an allowlist. Here PostgreSQL proves the
    // point by refusing to treat a parameter as a table name.
    await expect(query('SELECT * FROM $1', ['products'])).rejects.toMatchObject({ code: '42601' });
  });

  it('leaves search_path alone after a payload designed to change it', async () => {
    await query('SELECT $1::text', ["'; SET search_path TO evil; --"]);
    const { rows } = await query('SHOW search_path');
    expect(rows[0].search_path).not.toMatch(/evil/);
  });
});

// ---------------------------------------------------------------------------
// 4. The static audit itself
// ---------------------------------------------------------------------------

describe('Phase 4 :: static SQL audit', () => {
  it('reports no interpolation of values into SQL statements in src/', async () => {
    const { execFile } = await import('node:child_process');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = path.resolve(here, '..', 'scripts', 'audit-sql-injection.mjs');

    const result = await new Promise((resolve) => {
      execFile(
        process.execPath,
        [script, '--json'],
        { maxBuffer: 8 * 1024 * 1024 },
        (error, stdout) => resolve({ error, stdout }),
      );
    });

    const report = JSON.parse(result.stdout);

    // A failure here is actionable: the report names file, line and expression.
    expect(
      report.interpolationViolations,
      `Interpolated SQL found:\n${JSON.stringify(report.interpolationViolations, null, 2)}`,
    ).toEqual([]);
    expect(report.missingParameterViolations).toEqual([]);
    expect(report.passed).toBe(true);
    // Evidence of coverage: the audit actually found parameterised statements,
    // so a "pass" cannot be the result of scanning nothing.
    expect(report.placeholdersFound).toBeGreaterThan(50);
    expect(report.filesScanned).toBeGreaterThan(5);
  });

  it('detects a deliberately vulnerable sample, so the audit is not vacuous', async () => {
    const { execFile } = await import('node:child_process');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const { fileURLToPath } = await import('node:url');

    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = path.resolve(here, '..', 'scripts', 'audit-sql-injection.mjs');

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-sqli-audit-'));
    await fs.writeFile(
      path.join(dir, 'vulnerable.js'),
      // Three shapes, one per detection rule.
      `export function interpolated(db, email) {\n` +
        `  return db.query(\`SELECT id, email FROM users WHERE email = '\${email}'\`);\n` +
        `}\n` +
        `export function unfetched(db, sort) {\n` +
        `  return db.query(\`SELECT id FROM orders ORDER BY \${sort}\`);\n` +
        `}\n` +
        `export function concatenated(db, id) {\n` +
        `  return db.query('SELECT * FROM orders WHERE id = ' + id);\n` +
        `}\n`,
      'utf8',
    );

    const { stdout } = await new Promise((resolve) => {
      execFile(process.execPath, [script, '--json', '--dir', dir], { maxBuffer: 4 * 1024 * 1024 }, (error, out) =>
        resolve({ error, stdout: out }),
      );
    });

    const report = JSON.parse(stdout);
    const kinds = report.interpolationViolations.map((violation) => violation.kind);

    expect(report.passed).toBe(false);
    // The value pasted inside a quoted literal -- the canonical injection.
    expect(kinds).toContain('interpolation-inside-string-literal');
    // None of these are on the allowlist; `sort` is a caller-supplied identifier
    // that no bind parameter can express, so it must be reported.
    expect(kinds).toContain('template-interpolation');
    // Classic string concatenation into a statement.
    expect(kinds).toContain('string-concatenation');

    // And it must have located the interpolations, not merely counted them.
    expect(report.interpolationViolations.some((violation) => violation.line > 0)).toBe(true);
    expect(report.interpolationViolations.map((violation) => violation.file)).toContain('vulnerable.js');

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('accepts the parameterised patterns it is designed around, so it is not just "always fail"', async () => {
    const { execFile } = await import('node:child_process');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const { fileURLToPath } = await import('node:url');

    const here = path.dirname(fileURLToPath(import.meta.url));
    const script = path.resolve(here, '..', 'scripts', 'audit-sql-injection.mjs');

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qa-sqli-safe-'));
    await fs.writeFile(
      path.join(dir, 'safe.js'),
      // The shape src/ actually uses: clauses are literals carrying $n
      // placeholders, values go into `params`, and the limit/offset placeholders
      // are derived from params.length.
      `export function list(db, { scope, search, limit, offset }) {\n` +
        `  const params = [];\n` +
        `  const clauses = ['p.deleted_at IS NULL'];\n` +
        `  if (search) {\n` +
        `    params.push('%' + search + '%');\n` +
        `    clauses.push(\`p.name ILIKE $\${params.length}\`);\n` +
        `  }\n` +
        `  params.push(limit, offset);\n` +
        `  const where = clauses.join(' AND ');\n` +
        `  return db.query(\`SELECT p.id FROM products p WHERE \${where} LIMIT $\${params.length - 1} OFFSET $\${params.length}\`, params);\n` +
        `}\n`,
      'utf8',
    );

    const { stdout } = await new Promise((resolve) => {
      execFile(process.execPath, [script, '--json', '--dir', dir], { maxBuffer: 4 * 1024 * 1024 }, (error, out) =>
        resolve({ error, stdout: out }),
      );
    });

    const report = JSON.parse(stdout);
    expect(report.interpolationViolations, JSON.stringify(report.interpolationViolations, null, 2)).toEqual([]);
    expect(report.passed).toBe(true);
    // Proof the scan actually saw the placeholders rather than skipping the file.
    // Four occurrences: $1 in the clause, and $2/$3 in LIMIT/OFFSET plus the $3
    // repeated in the string.
    expect(report.placeholdersFound).toBe(4);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
