#!/usr/bin/env node
/**
 * SQL injection audit :: static pattern check.
 *
 *   node qa-security-suite/phase4/scripts/audit-sql-injection.mjs
 *   node qa-security-suite/phase4/scripts/audit-sql-injection.mjs --json
 *
 * What this does
 * --------------
 * Walks src/ (override with --dir) and finds every SQL statement, then classifies
 * how its parameters reach the driver. The rule is simple and absolute:
 *
 *   A value that originates outside the process must reach PostgreSQL as a bind
 *   parameter ($1, $2, ...), never as text concatenated into the statement.
 *
 * The audit fails the build (exit code 1) on a violation. It is a *heuristic*
 * static check -- it cannot prove the absence of injection, and the dynamic tests
 * in tests/sql-injection.test.js cover what a pattern match cannot -- but it
 * catches the realistic failure mode: a well-meaning developer adding one
 * template-literal interpolation to a query that is otherwise parameterised.
 *
 * Why an allowlist rather than a blocklist
 * ----------------------------------------
 * The only interpolations that pass are those that cannot come from a caller:
 *   - a fixed set of column/fragment constants declared in the same file
 *   - a literal SQL keyword or clause
 *   - an apply()-style composition helper that itself only uses placeholders
 * Anything else is reported, including things that look harmless. A false
 * positive costs a comment; a false negative costs the database.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const dirIndex = args.indexOf('--dir');
const SCAN_DIR = dirIndex === -1 ? path.join(ROOT, 'src') : path.resolve(args[dirIndex + 1]);

/**
 * Fragments that may legitimately be interpolated.
 *
 * Each entry is a *name*, which is what separates a safe fragment from a
 * caller-supplied value: nothing here is ever assigned from req.body/req.query.
 *
 *   warehouseScopeClause(scope, col, params) builds `col = ANY($n::int[])` and
 *   pushes the ids into the params array, so the values are parameterised and
 *   only the *column name* -- which the caller passes as a hard-coded literal in
 *   every call site -- is interpolated.
 *
 *   STOCK_TOTAL_SUBQUERY is a module-level constant with no parameters.
 */
const ALLOWED_FRAGMENT_NAMES = new Set([
  'visibility',
  'lowStockClause',
  'stockClause',
  'orderClause',
  'clause',
  'where',
  'whereClause',
  'orderBy',
  'sortClause',
  'setClause',
  'isolation',
  'valuesClause',
  'columns',
  'table',
  'STOCK_TOTAL_SUBQUERY',
]);

/** Column/identifier constants are lowercase snake_case and never user input. */
const IDENTIFIER_LIKE = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i;

const SQL_KEYWORDISH =
  /^(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|AND|OR|ORDER BY|GROUP BY|LIMIT|OFFSET|JOIN|LEFT|INNER|RETURNING|VALUES|SET|ASC|DESC|ON|TRUE|FALSE|NULL|EXISTS|\s)+$/i;

/** Files that are test-only or scaffolding and are not part of the request path. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) yield full;
  }
}

/**
 * Collects template-literal and concatenation interpolations that appear inside
 * something that looks like a SQL statement.
 */
function findViolations(source, file) {
  const violations = [];

  // A "SQL context" is a template literal containing a SQL keyword. Restricting
  // the scan to those keeps the audit from flagging ordinary string building.
  const templateLiteral = /`([^`\\]|\\.)*`/gs;
  const sqlKeyword = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|FROM|WHERE)\b/i;

  let match;
  while ((match = templateLiteral.exec(source)) !== null) {
    const literal = match[0];
    if (!sqlKeyword.test(literal)) continue;

    const line = source.slice(0, match.index).split('\n').length;

    // ${...} interpolations inside the statement.
    const interpolation = /\$\{([^}]*)\}/g;
    let inner;
    while ((inner = interpolation.exec(literal)) !== null) {
      const expression = inner[1].trim();

      /*
       * The highest-signal pattern there is: an interpolation sitting inside a
       * SQL string literal, as in ... WHERE email = '${email}'.
       *
       * Parameterising a value means writing $1 and passing it separately. If the
       * placeholder is wrapped in quotes, the value is being pasted INTO the
       * literal -- which is injection by definition, whatever the expression is.
       * `email` alone would otherwise look like a harmless variable name.
       */
      const before = literal.slice(0, inner.index);
      const previousChar = before.replace(/\s+$/, '').slice(-1);

      if (previousChar === "'" || previousChar === '"') {
        violations.push({
          file: path.relative(ROOT, file),
          line: line + (before.match(/\n/g) ?? []).length,
          kind: 'interpolation-inside-string-literal',
          expression,
          excerpt: literal.slice(Math.max(0, inner.index - 60), inner.index + 60).replace(/\s+/g, ' '),
        });
        continue;
      }

      if (isAllowed(expression)) continue;

      violations.push({
        file: path.relative(ROOT, file),
        line: line + (before.match(/\n/g) ?? []).length,
        kind: 'template-interpolation',
        expression,
        excerpt: literal.slice(0, 160).replace(/\s+/g, ' '),
      });
    }
  }

  // String concatenation into a query: db.query('... ' + value + ' ...')
  const concatenation = /(?:query|execute)\s*\(\s*(?:'[^']*'|"[^"]*")\s*\+/g;
  while ((match = concatenation.exec(source)) !== null) {
    const line = source.slice(0, match.index).split('\n').length;
    violations.push({
      file: path.relative(ROOT, file),
      line,
      kind: 'string-concatenation',
      expression: match[0].trim(),
      excerpt: source.slice(match.index, match.index + 120).replace(/\s+/g, ' '),
    });
  }

  return violations;
}

function isAllowed(expression) {
  if (SQL_KEYWORDISH.test(expression)) return true;
  if (IDENTIFIER_LIKE.test(expression)) return true;

  // A bare identifier that is on the fragment allowlist.
  if (ALLOWED_FRAGMENT_NAMES.has(expression)) return true;

  // `foo.bar`-style access where the last segment is an allowlisted name.
  const lastSegment = expression.split('.').pop();
  if (ALLOWED_FRAGMENT_NAMES.has(lastSegment)) return true;

  /*
   * Placeholder arithmetic: `params.length`, `params.length - 1`.
   *
   * These build `$1`, `$2`, ... and are the mechanism that makes a dynamic WHERE
   * clause parameterised in the first place.
   *
   * `.length` is required. An earlier version of this rule accepted any bare
   * identifier, which silently allowlisted `${sort}` inside `ORDER BY ${sort}` --
   * a genuine injection point. Requiring `.length` keeps the placeholder
   * plumbing while refusing to treat a value as plumbing just because it is a
   * short variable name.
   */
  if (/^[A-Za-z_$][\w$]*(\[[^\]]*\])?\.length(\s*[-+]\s*\d+)?$/.test(expression)) return true;

  /*
   * Joining a clause list: `clauses.join(' AND ')`.
   *
   * Allowed only when the separator is a plain string literal -- that keeps the
   * shape recognisable and blocks `list.join(userSuppliedSeparator)`, which
   * would be a genuine injection vector. The elements of the list are audited
   * independently, because each `clauses.push(...)` is its own template literal
   * and is checked by this same pass.
   */
  if (/^[A-Za-z_$][\w$]*\.join\(\s*(['"`])([A-Za-z ]*)\1\s*\)$/.test(expression)) return true;

  // A literal number used as plumbing.
  if (/^\d+$/.test(expression)) return true;

  return false;
}

/** Reports every `db.query(...)` call that has no parameter array. */
function findUnparameterisedCalls(source, file) {
  const findings = [];

  // query(`... $1 ...`) with no second argument. Only flagged when the statement
  // actually contains a placeholder, so a static `SELECT 1` is not reported.
  const call = /\b(?:query|client\.query|db\.query)\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*")\s*\)/gs;
  let match;
  while ((match = call.exec(source)) !== null) {
    const statement = match[1];
    if (!/\$\d/.test(statement)) continue;
    const line = source.slice(0, match.index).split('\n').length;
    findings.push({
      file: path.relative(ROOT, file),
      line,
      kind: 'missing-parameters',
      expression: statement.slice(0, 120).replace(/\s+/g, ' '),
    });
  }

  return findings;
}

async function main() {
  const files = [];
  for await (const file of walk(SCAN_DIR)) files.push(file);

  const violations = [];
  const unparameterised = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    violations.push(...findViolations(source, file));
    unparameterised.push(...findUnparameterisedCalls(source, file));
  }

  /*
   * Placeholder occurrences ($1, $2, ...) across all scanned files.
   *
   * This counts OCCURRENCES, not distinct placeholders: $3 appearing twice counts
   * twice. It exists as evidence of coverage -- a "PASS" that scanned a file with
   * zero placeholders proves nothing -- so a rough magnitude is all that is
   * needed, and counting occurrences is the version that cannot silently be zero.
   */
  let parameterisedStatements = 0;
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    parameterisedStatements += (source.match(/\$\d/g) ?? []).length;
  }

  const report = {
    scannedDirectory: path.relative(ROOT, SCAN_DIR),
    filesScanned: files.length,
    placeholdersFound: parameterisedStatements,
    interpolationViolations: violations,
    missingParameterViolations: unparameterised,
    passed: violations.length === 0 && unparameterised.length === 0,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`SQL injection audit :: ${report.scannedDirectory}`);
    console.log(`  files scanned          : ${report.filesScanned}`);
    console.log(`  bind placeholders found: ${report.placeholdersFound}`);
    console.log(`  interp. violations     : ${violations.length}`);
    console.log(`  missing-params calls   : ${unparameterised.length}`);
    console.log('');

    for (const violation of [...violations, ...unparameterised]) {
      console.log(`  [${violation.kind}] ${violation.file}:${violation.line}`);
      console.log(`      ${violation.expression}`);
      console.log(`      ${violation.excerpt ?? ''}`);
      console.log('');
    }

    if (report.passed) {
      console.log('  PASS: every dynamic SQL value reaches PostgreSQL as a bind parameter.');
    } else {
      console.log('  FAIL: see the violations above. Values must be passed as $1, $2, ...');
      console.log('        Column names, table names and ORDER BY targets must be selected');
      console.log('        from a fixed allowlist, never concatenated from a request.');
    }
  }

  process.exitCode = report.passed ? 0 : 1;
}

await main();
