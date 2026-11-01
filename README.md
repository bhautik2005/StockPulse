# StockPulse

**Enterprise B2B multi-warehouse inventory & supply chain management system.**

StockPulse is built around one promise: **an order either happens completely or not at all, and no sequence of concurrent requests can ever oversell stock.** This document describes what the project contains, how it works, the end-to-end flows (authentication, password reset, ordering, user lifecycle), the Docker deployment, and every test case in the suite.

---

## Table of contents

- [Quick start](#quick-start)
- [What's in the project](#whats-in-the-project)
- [Architecture](#architecture)
- [How a request flows](#how-a-request-flows)
- [Flows](#flows)
  - [Authentication flow](#1-authentication-flow)
  - [Password reset flow](#2-password-reset-flow)
  - [Order placement flow](#3-order-placement-flow)
  - [User lifecycle flow](#4-user-lifecycle-flow)
- [The order transaction](#the-order-transaction)
- [Schema corrections](#schema-corrections)
- [Authorisation model](#authorisation-model)
- [Security decisions](#security-decisions)
- [Money, time and errors](#money-time-and-errors)
- [Docker](#docker)
- [Test cases](#test-cases)
- [API reference](#api-reference)
- [Configuration](#configuration)
- [Known limitations / what comes next](#known-limitations--what-comes-next)

---

## Quick start

```bash
cp .env.example .env          # provides the local Compose configuration

docker compose up -d --build --wait
docker compose exec server npm run seed
```

The API applies pending database migrations before it starts accepting requests — there is no separate migration step to remember. Run the seed command afterward to create the demo accounts and sample inventory.

| | |
|---|---|
| Frontend | http://localhost:5173 |
| API | http://localhost:5000 |
| Adminer (database UI) | http://localhost:8080 — server `db`, user `bhautik`, password `bhautik`, database `StockPulse` |
| Database | `localhost:5432` — from the app: `postgres://bhautik:bhautik@127.0.0.1:5432/StockPulse` |

Check it is alive, then sign in and place an order:

```bash
curl -s localhost:5000/health

curl -s -X POST localhost:5000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"client@acme.dev","password":"ClientPass1234"}'
```

### Demo accounts (created by `npm run seed`)

| Role | Email | Password | Lands on |
|---|---|---|---|
| Admin | `admin@stockpulse.dev` | `AdminPass1234` | `/dashboard` |
| Manager | `manager.nairobi@stockpulse.dev` | `ManagerPass1234` | `/dashboard` |
| Manager | `manager.lagos@stockpulse.dev` | `ManagerPass1234` | `/dashboard` |
| Staff | `staff.nairobi@stockpulse.dev` | `StaffPass1234` | `/dashboard` |
| Client | `client@acme.dev` | `ClientPass1234` | `/products` |

Warehouses seeded: `WH-NBO` (Nairobi Central), `WH-LAG` (Lagos Distribution), `WH-DXB` (Dubai Fulfilment).

If login returns `401 INVALID_CREDENTIALS`, the API did reach the database; the email/password pair was not found. Run `docker compose exec server npm run seed`.

### Two things worth knowing

- **The database name is case-sensitive.** Compose creates `StockPulse`, and PostgreSQL will not find `stockpulse`. The name is created quoted (`CREATE DATABASE "StockPulse"`), so those capitals are real and must appear in `DATABASE_URL` exactly.
- **The data lives in `./.pgdata`** on the host and is git-ignored. `docker compose down` keeps it; `docker compose down -v` does not — with a bind mount, only removing `./.pgdata` itself actually deletes it.

### Without Docker

The project also ships a real PostgreSQL server in `node_modules` (`@embedded-postgres`), which needs no install and no daemon:

```bash
# swap the DATABASE_URL line in .env for the bundled one, then:
npm run db:up
```

`npm run db:up` starts a genuine PostgreSQL 18 server from the binaries under `node_modules/@embedded-postgres/<platform>/native/bin`, bound to `127.0.0.1:55432` only. If `DATABASE_URL` points at some other server, the script **never** starts a second one behind your back: if that server is reachable it does nothing, and if it is not it fails with instructions rather than leaving the app connected to nothing.

> **Why a real server and not an embedded emulator:** the guarantees this project makes are PostgreSQL semantics — row-lock re-evaluation under `READ COMMITTED` and atomic conditional `UPDATE`. An in-memory emulator cannot demonstrate them, so it could not defend the central claim.

---

## What's in the project

### Backend modules (`src/modules/`)

| Module | Responsibility |
|---|---|
| `auth` | Register, login, logout, session profile, password reset, and Admin user administration |
| `admin` | Read-only operational overview and cross-user inspection for Admins |
| `products` | Internal catalogue (Admin/Manager) and the Client-facing catalogue view |
| `warehouses` | Warehouse CRUD plus nested per-warehouse inventory, ledger and fulfilment queue |
| `inventory` | Stock listing, low-stock reporting, manual adjustments, the movement ledger |
| `orders` | Order placement, lifecycle, cancellation, and bulk CSV/XLSX import |
| `analytics` | Dashboard summary, sales trend, top products, per-warehouse breakdown |

### Frontend pages (`client/src/pages/`)

| Route | Page | Who can reach it |
|---|---|---|
| `/login` | Sign in (with show/hide password + "Forgot password?") | anyone |
| `/register` | Client self-service sign-up | anyone |
| `/forgot-password` | Request a reset link | anyone |
| `/reset-password?token=…` | Choose a new password | anyone holding a valid link |
| `/dashboard` | Metrics and charts | Admin, Manager, Staff |
| `/warehouses` | Warehouse list and detail | Admin, Manager, Staff |
| `/inventory` | Scoped stock, adjustments, ledger | Admin, Manager, Staff |
| `/products` | Catalogue management, bulk import, archive | all roles (the page adapts) |
| `/orders` | Order builder, lifecycle, bulk import | all roles (scoped) |
| `/users` | User administration, delete/reinstate | Admin only |
| `*` | Not-found page | anyone |

### Supporting pieces

- **Client-side guards** — `RequireAuth`, `RequireInternal`, `RequireRole`, `ErrorBoundary`, `FullPageSpinner` (`client/src/components/RequireAuth.jsx`).
- **API layer** — one `request()` in `client/src/services/api.js` (credentials, CSRF header, typed `ApiError`), with endpoint wrappers in `endpoints.js` so a URL exists in exactly one place.
- **Design system** — `client/src/components/ui/` (Button, Input, Dialog, Table, Tabs, Toast, Badge, Card, Pagination, DropdownMenu, Feedback, PasswordInput), plus `PasswordStrength.jsx`.
- **Migrations** — `001_init.sql` (schema, constraints, views) and `002_password_reset_tokens.sql` (reset tokens).
- **Seed** — `src/db/seed.js`, idempotent demo data.

---

## Architecture

```
src/
  config/env.js            validated, frozen configuration (fails fast at boot)
  db/
    pool.js                pg.Pool + withTransaction() + health/pool stats
    migrate.js             forward-only runner with checksums
    migrations/*.sql       the schema (all guarantees live here)
    seed.js                idempotent demo data
  errors/AppError.js       typed errors carrying machine-readable codes
  lib/                     logger, password, tokens, resetTokens, mailer,
                           emailTemplates, CSRF, scope helpers, schemas
  middleware/              asyncHandler, errorHandler, validate, authenticate, authorize
  modules/                 auth, admin, products, warehouses, inventory, orders, analytics
  app.js                   Express assembly
  index.js                 bootstrap (migrate → listen) + graceful shutdown

client/
  src/
    pages/                 one file per route
    components/            ui/ primitives + feature components (orders/, products/)
    context/AuthContext.jsx  session state, hydration, 401 handling
    layouts/               AuthLayout (split screen), DashboardLayout (shell)
    services/              api.js (transport) + endpoints.js (one place per URL)
    lib/                   constants (roles, statuses, transitions), errors, utils
  nginx.conf               SPA fallback: try_files $uri $uri/ /index.html
```

Layering, applied consistently:

```
HTTP        routes      → validate input, delegate, shape the response
Business    service     → rules, transaction boundaries, authorisation decisions
Persistence repository  → SQL
```

Repositories are used where the SQL **is** the business rule (orders, inventory, users, password reset). For simple CRUD domains (warehouses, products) the SQL lives in the service — a separate file that only forwards a query adds indirection without adding clarity.

---

## How a request flows

```
Browser
  │  fetch('/api/...', { credentials: 'include' })
  │  + X-CSRF-Token on writes
  ▼
nginx :5173 ──/api/*──►  (SPA is served from the same origin in the Compose stack)
  │
  ▼
Express :5000
  1. helmet headers (incl. Referrer-Policy: no-referrer)
  2. CORS allow-list with credentials
  3. express.json, bounded to 256kb
  4. cookie-parser
  5. correlation id + one structured log line per request
  6. route: validate(zod) → service → repository → PostgreSQL
  7. errorHandler: maps AppError / SQLSTATE to one JSON error shape
```

Two transport details matter:

- **The client is not a proxy.** In the Compose stack nginx serves the built SPA and the browser calls the API directly on `:5000`, so CORS and credentials are real and exercised, not side-stepped.
- **Money arrives as a string.** `NUMERIC`/`BIGINT` are configured to return as text from `pg`, so no value round-trips through a float.

---

## Flows

### 1. Authentication flow

```
POST /api/auth/login { email, password }
        │
        ├─ 1. findUserByEmail (WHERE lower(email) = lower($1) AND deleted_at IS NULL)
        ├─ 2. bcrypt compare against the stored hash — or against DUMMY_HASH when the
        │     email is unknown, so both failure modes take the same time
        ├─ 3. is_active check → 403 ACCOUNT_DISABLED
        ├─ 4. signAccessToken → JWT { sub, role, tv } , 15m, issuer 'stockpulse'
        └─ 5. set sp_token (HttpOnly, SameSite, Secure in prod)
              set sp_csrf  (readable — the double-submit half)
              body also carries `token` for Bearer/Postman/CI clients
        ▼
Every subsequent request
        │
        ├─ extractToken(): cookie sp_token  → source 'cookie'
        │                  Authorization: Bearer …  → source 'bearer'
        ├─ verifyAccessToken(): signature, expiry, issuer
        ├─ RE-READ the user from the database (never trust the token's role)
        ├─ is_active check  +  token_version === JWT.tv
        └─ if source === 'cookie': assertCsrf  (skipped for Bearer — nothing
                                                 attaches a Bearer token ambiently)
```

Why it is built this way:

- **The session lives in an HttpOnly cookie**, so an XSS bug cannot exfiltrate it. Nothing is kept in `localStorage`.
- **The role is re-read from the database on every request.** A demotion, a deactivation or a password change therefore takes effect on the *next request* instead of when the token happens to expire.
- **`token_version` is the revocation primitive.** Bumping it invalidates every token ever issued to that account. It is bumped by: an Admin changing a role, an Admin disabling an account, `DELETE /api/users/:id`, `POST /api/auth/logout?all=true`, and every successful password reset.
- **CSRF is enforced inside the authentication middleware**, bound to cookie auth. A new route cannot forget it, because the check is not opt-in.
- **The last active Admin cannot be demoted or disabled** — there is no in-app recovery from a system with no admin.

### 2. Password reset flow

```
  (a) User clicks "Forgot password?" on /login  →  /forgot-password
        │
POST /api/auth/forgot-password { email }
        ├─ mint crypto.randomBytes(32) → 64-hex token, hash it with SHA-256
        │    … unconditionally, before the eligibility branch, so an unknown address
        │      costs the same CPU as a real one
        ├─ eligible = row exists AND is_active   (deleted accounts are excluded by SQL)
        ├─ if eligible: mark every outstanding token used, insert the new hash,
        │     expires_at = now() + RESET_TOKEN_TTL_MINUTES (default 30)
        └─ dispatch the email WITHOUT awaiting it, then reply 200 with one constant:
             "If an account exists with this email address, you will receive a
              reset link shortly."
        ▼
  (b) User opens the emailed link  →  /reset-password?token=<raw>
        │
POST /api/auth/validate-reset-token { token }
        ├─ shape check (64 lowercase hex) — anything else is simply not valid
        ├─ SELECT by hash, joined to the user
        └─ { valid: true|false }   ← does NOT spend the token, so a reload or a
                                     browser prefetch keeps the form usable
        ▼
  (c) User submits the new password
        │
POST /api/auth/reset-password { token, password, confirmPassword }
        ├─ 1. reject malformed token, then a cheap lookup (no bcrypt for junk)
        ├─ 2. hash the new password OUTSIDE the transaction (bcrypt ~250ms at cost 12
        │      must not hold a pooled connection or a row lock)
        └─ 3. withTransaction:
               UPDATE password_reset_tokens SET used_at = now()
                WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
                RETURNING user_id              ← the entire single-use guarantee
               UPDATE users SET password_hash = $2, token_version = token_version + 1
               UPDATE … SET used_at = now() WHERE user_id = $1 AND used_at IS NULL
        ▼
  (d) After COMMIT: email "your password was changed", reply success.
      NO cookie, NO token → the user signs in with the new password.
```

Security properties of that flow:

- **Only the SHA-256 digest is stored.** A database dump yields no working reset links. (A plain SHA-256, not bcrypt, is correct here: the input is 256 bits of true randomness, so there is no dictionary to attack.)
- **Single use is the database's job.** Under `READ COMMITTED`, a second concurrent `UPDATE` blocks on the row lock and then re-evaluates `used_at IS NULL` against the committed row, matching zero rows. No advisory locks, no `SELECT … FOR UPDATE` round trip.
- **One live link per account** — requesting again retires the previous token.
- **No account enumeration.** Three mechanisms together: equal token work on both paths, a non-blocking email dispatch (so response time does not jump by an SMTP round-trip only for real accounts), and a constant reply body.
- **The link is built from `FRONTEND_URL`, never from the request's `Host` header** — a spoofed host must not be able to redirect the token to another domain.
- **A reset cannot re-enable a disabled account**, and cannot change a role, `is_active`, or any warehouse grant.
- **A reset revokes every session** (the `token_version` bump in the same transaction).
- **Reset does not sign the user in.** The link proves control of a mailbox, not knowledge of the new password.
- **`Referrer-Policy: no-referrer`** (server header + `<meta name="referrer">`) so the token in the query string cannot leak through the `Referer` header to any resource the page loads.
- **Two rate limits**: per IP (default 5 / 15 min) and per account (default 3 / hour, keyed on the *hash* of the normalised email so the limiter store never becomes a list of who has an account).

### 3. Order placement flow

`POST /api/orders` runs entirely inside one transaction on one connection:

```
 1. idempotency lookup         a retry must not become a second order
 2. product lock + validation  SELECT ... FOR SHARE — the price cannot move under us
 3. warehouse resolution       explicit, or allocated to the deepest stock position
 4. inventory row locks        ordered by (product_id, warehouse_id) → no deadlocks
 5. order header + lines       total computed in SQL from current prices
 6. conditional decrement      the guard that makes overselling impossible
 7. ledger + status history    the movement is explained in the same commit
```

See [The order transaction](#the-order-transaction) for the statement that makes this true.

### 4. User lifecycle flow

```
Create     POST /api/users                 Admin only. Zod strips unknown fields, so
                                           public registration can never create an Admin.
Update     PATCH /api/users/:id            role / is_active. A role change or a
                                           deactivation bumps token_version immediately.
Grant      POST /api/users/:id/warehouse-access   attaches Manager/Staff to warehouses
Delete     DELETE /api/users/:id           Admin only, and refused for:
                                             - yourself
                                             - an Admin
                                             - an active account (deactivate first)
                                           It is a SOFT delete: deleted_at = now(),
                                           is_active = false, token_version + 1,
                                           release managed warehouses, drop grants.
                                           The account disappears from every read path
                                           and its tokens stop working, but the rows that
                                           reference it (orders, ledger) are preserved
                                           because they are ON DELETE RESTRICT.
```

Why a soft delete rather than a real one: `orders.client_id` and `warehouses.manager_id` are `ON DELETE RESTRICT`, deliberately — financial history must not vanish because someone tidied up the user list.

---

## The order transaction

### The one statement that matters

```sql
UPDATE inventory i
   SET quantity = i.quantity - r.qty
  FROM requested r
 WHERE i.product_id   = r.product_id
   AND i.warehouse_id = r.warehouse_id
   AND i.quantity    >= r.qty        -- ← evaluated by the database, on the row
RETURNING i.quantity AS remaining;
```

Under `READ COMMITTED`, if another transaction has already committed a decrement, this statement waits on the row lock and then **re-evaluates the predicate against the new value**. Either it updates, or the row is skipped and `rowCount` comes up short — in which case the whole transaction is rolled back and the client receives a `409` naming exactly which line fell short and by how much.

A read-then-write implementation (`SELECT quantity`, check in JavaScript, then `UPDATE`) cannot offer this guarantee at any isolation level below `SERIALIZABLE`. That is the difference between "uses transactions" and "cannot oversell".

### Supporting decisions

- **Lock ordering.** `lockInventoryRows` sorts by `(product_id, warehouse_id)` before touching anything. Two orders touching products `{1,2}` and `{2,1}` would otherwise be able to deadlock.
- **Duplicate lines are merged.** `UPDATE ... FROM` with two source rows matching one target updates it *once*, with an unpredictable winner. An unmerged payload of `[{A,3},{A,4}]` could consume 3 or 4; merging makes it exactly 7.
- **Totals are computed server-side** from stored prices in `NUMERIC` arithmetic. A client-supplied `total_amount` is stripped by the validator and never read.
- **Cancellation is a separate endpoint.** `PATCH /api/orders/:id/status` refuses `Cancelled` outright, because cancellation also restocks and writes a ledger row. One cancellation path means an order can never be cancelled without its stock coming back.
- **Everything is attributed.** Every quantity change writes an `inventory_transactions` row with a reason (`receipt`, `sale`, `adjustment`, `restock`) and an actor.

---

## Schema corrections

The original draft DDL was a reasonable start but stored several business rules nowhere, and left the order-to-warehouse relationship unmodelled. Every fix below is enforced by PostgreSQL, not by convention. Full annotated list in `src/db/migrations/001_init.sql`.

### Correctness

| # | Problem in the draft | Fix |
|---|---|---|
| 1 | `role CHECK (... 'Admin','Manager','Staff')` while the spec described a *Client* buyer — a `VARCHAR` CHECK only fails at runtime | `Client` added as a first-class role |
| 2 | A demoted Admin kept Admin rights until their token expired | `users.token_version`; bumping it invalidates every issued token |
| 3 | `UNIQUE(email)` allowed `Ada@x.com` and `ada@x.com` as separate accounts | unique index on `lower(email)` |
| 4 | `manager_id ... ON DELETE SET NULL` silently orphaned warehouses | `ON DELETE RESTRICT` + soft delete |
| 5 | Nothing stopped one manager owning five warehouses | partial unique index (one manager per warehouse) |
| 6 | No way to say "this Staff member works at warehouse 3" → warehouse scoping impossible | `user_warehouses` grant table |
| 7 | `unit_price`, `total_amount`, `quantity` had no bounds | `CHECK` constraints on all of them |
| 8 | `UNIQUE(sku)` was case-sensitive | unique index on `upper(sku)` |
| 9 | `ON DELETE CASCADE` on inventory destroyed the audit trail | `RESTRICT` + soft delete |
| 10 | **Nothing linked an order to a warehouse** | `order_items.warehouse_id NOT NULL` — per line, so split shipments need no migration |
| 11 | `order_items.product_id ON DELETE SET NULL` erased *what was sold* | SKU and product name snapshotted onto the line |
| 12 | `order_items.quantity` had no `CHECK` — `0` and `-5` were storable | `CHECK (quantity > 0)` |
| 13 | No partial-fulfilment state | `Partially Shipped` added to the status domain |
| 14 | No protection against a double-clicked "Place Order" | `orders.idempotency_key UNIQUE` |
| 15 | An order could be cancelled with no explanation | `CHECK (status <> 'Cancelled' OR cancelled_reason IS NOT NULL)` |
| 16 | Stock was a mutable counter with no history | `inventory_transactions`, append-only |
| 17 | Reorder level was global, so a SKU could be critical in one city and overstocked in another | `inventory.reorder_level` with the product value as fallback |

### Operational

| # | Problem | Fix |
|---|---|---|
| 18 | **PostgreSQL does not auto-index foreign keys** — every FK lookup was a sequential scan | 10 explicit indexes (asserted by a test) |
| 19 | `TIMESTAMP` without time zone made "revenue today" depend on the server's locale | `TIMESTAMPTZ` throughout |
| 20 | No `updated_at` maintenance | trigger, so the application cannot forget |
| 21 | No human-readable reference | `order_number` (`SO-2026-000431`) |
| 22 | No audit trail for state changes | `order_status_history` |

Two reporting views (`low_stock`, `product_stock_totals`) make the per-warehouse threshold logic a single source of truth rather than something each query reinvents.

`002_password_reset_tokens.sql` adds the reset-token table: `integer` identity PK, `user_id` FK `ON DELETE CASCADE` (a reset link has no historical value, unlike an order), `token_hash varchar(64)` with a UNIQUE index, `expires_at`, `used_at`, and a partial index on live tokens.

---

## Authorisation model

Four roles, two independent questions answered before any data is returned:

```
1. Is this role allowed to perform this kind of action?   → requireRole()
2. Is this specific record inside the caller's scope?     → attachWarehouseScope()
```

| Role | Scope | Can |
|---|---|---|
| `Admin` | all warehouses | everything |
| `Manager` | assigned warehouses | stock, fulfilment, catalogue, analytics |
| `Staff` | assigned warehouses | stock, fulfilment, analytics |
| `Client` | own orders only | browse catalogue, place and cancel orders |

The scope is **data, not a boolean** (`{ all: true }` or `{ all: false, ids: [] }`) so it is pushed straight into SQL:

```js
const clause = warehouseScopeClause(req.warehouseScope, 'i.warehouse_id', params);
// -> 'i.warehouse_id = ANY($1::int[])'     or 'FALSE' when the scope is empty
```

An unauthorised row is never read out of the database at all, and an empty scope yields `FALSE` — the system fails **closed**.

Two details worth calling out:

- **Out-of-scope single records return `404`, not `403`.** A `403` confirms the id exists, which lets someone enumerate other customers' orders.
- **Analytics are genuinely scoped.** A Manager's revenue is the value of lines in *their* warehouses, not the total of orders that happen to touch them.

---

## Security decisions

- **JWT in an HttpOnly cookie** (`sp_token`) so an XSS bug cannot exfiltrate the session, plus `Authorization: Bearer` for Postman/CI/device clients.
- **CSRF double-submit**, bound to cookie authentication: the check lives inside the authentication middleware, so a new route *cannot* forget it.
- **Role is re-read from the database on every request** rather than trusted from the token payload.
- **Public registration can only create a `Client`.** The validator strips unknown fields, so sending `role: "Admin"` achieves nothing.
- **No user enumeration** on login (dummy-hash comparison) or on password reset (constant reply, equal work, non-blocking email).
- **Reset tokens are stored only as SHA-256 digests**, single-use, expiring, and invalidate their predecessors.
- **The last active administrator cannot be demoted or disabled.**
- **Rate limiting** (`express-rate-limit`) on login and on both reset endpoints. The per-account reset bucket is keyed on a truncated SHA-256 of the email, so the limiter's in-memory store cannot be read as a list of which addresses have accounts.
- **Helmet** with an explicit `Referrer-Policy: no-referrer`, an explicit CORS origin list with credentials, and a bounded (256 kb) JSON body.
- **Server-side timeouts** (`statement_timeout`, `lock_timeout`, pool acquire timeout) so one stuck query cannot hold a pool slot forever. `/health` reports pool saturation, because "healthy" while every connection is checked out is the state that precedes collapse.
- **No secrets reach the client.** The SPA is a static bundle behind nginx; SMTP credentials are injected only into the API container.

---

## Money, time and errors

- **Money is `NUMERIC`, never a float**, and arrives in JSON as a **string** (`"498.00"`). `0.1 + 0.2 !== 0.3` in IEEE-754; summing invoices in JavaScript is a defect, not a rounding preference. All arithmetic happens in SQL. (Tested: `3 × 0.10 → "0.30"`.)
- **Prices** are validated to at most 2 decimal places at the boundary rather than silently rounded by the database.
- **Time is `TIMESTAMPTZ`.** Day buckets are computed in an explicit timezone and **gap days are filled with zeros**, so a chart cannot imply revenue on a day that had none.
- **Errors have one shape**, with a machine-readable code:

  ```json
  { "error": { "code": "INSUFFICIENT_STOCK", "message": "...",
               "details": { "lines": [ { "product_id": 7, "warehouse_id": 1,
                                         "requested": 5, "available": 1 } ] },
               "requestId": "..." } }
  ```

  Refusals are specific: telling a client *which line* fell short and *by how much* is the difference between a usable API and a guessing game. `PG_ERROR_MAP` in `src/middleware/errorHandler.js` maps SQLSTATEs (`23505` → 409, `23514` → 400, `40001`/`40P01` → 409, `57014` → 503, …) so a database constraint violation is never a bare 500.

---

## Docker

`docker-compose.yml` defines four services on one bridge network (`stockpulse`):

| Service | Image / build | Port | Notes |
|---|---|---|---|
| `db` | `postgres:18-alpine` | `5432` | Bind-mounts `./.pgdata`. `PGDATA` is set explicitly so the path is meaningful on 16/17/18. Healthcheck via `pg_isready`. |
| `server` | `Dockerfile` (`node:22-alpine`) | `5000` | Production dependencies only (`npm ci --omit=dev --omit=optional`). Runs `node src/index.js`, which **migrates then listens**. Healthcheck on `/health`. |
| `client` | `client/Dockerfile` (multi-stage) | `5173` | Stage 1 builds the Vite SPA; stage 2 serves `/app/dist` from nginx with SPA fallback. |
| `adminer` | `adminer` | `8080` | Database UI. |

### Migrations happen on boot

`src/index.js` calls `migrate()` **before** the HTTP listener opens:

```
database migrations applied  { count: 1 }     ← e.g. 002_password_reset_tokens.sql
stockpulse api listening     { port: 5000, env: production }
```

The runner is forward-only and checksummed: it reads `src/db/migrations/*.sql` in sorted order, SHA-256s each file, records it in `schema_migrations`, and **refuses to run if an already-applied file has been edited**. Each file runs in its own transaction. There is no down-migration, by design — the schema only moves forward.

Consequence: adding a migration file and restarting the API is the entire deployment step. No manual SQL, no volume reset.

### Everyday commands

```bash
docker compose up -d --build --wait        # build + start, wait for health
docker compose ps                          # what is running
docker compose logs -f server              # follow API logs
docker compose exec server npm run seed    # create demo accounts + sample data
docker compose exec server npm run migrate # run migrations explicitly (also on boot)

docker compose exec db psql -U bhautik -d StockPulse -c '\dt'   # inspect schema
docker compose down                        # stop; ./.pgdata is KEPT
```

### Rules that matter

- **Never `docker compose down -v`** on a database you care about, and never delete `./.pgdata`. Both destroy the data.
- **Never `migrate --fresh`** against the Docker database — it drops and rebuilds the `public` schema. Use a separate database (e.g. `stockpulse_qa`) for test runs.
- `docker compose up -d --build` can report a non-zero exit code while still having recreated and started the containers successfully. Verify with `docker compose ps` and a request to `/health`, not with the exit code.
- **Windows + Docker Desktop:** if the client build fails with `[vite:esbuild-transpile] Access is denied`, point the build's temp directory inside the repository first:
  ```powershell
  $env:TEMP = "$PWD\.tmp-build"; $env:TMP = $env:TEMP
  docker compose up -d --build
  ```

### Environment passing

Docker Compose substitutes from `.env`. The `server` service explicitly forwards `DATABASE_URL` (from `DATABASE_URL1`), `JWT_SECRET`, `CORS_ORIGIN`, `COOKIE_SECURE`, `FRONTEND_URL`, `RESET_TOKEN_TTL_MINUTES`, `EMAIL_USER`, `EMAIL_PASS` and `EMAIL_FROM`. **A variable that is not listed there is not visible inside the container**, even if it is in `.env` — this is the usual cause of "it works locally but the container cannot send mail".

---

## Test cases

Three suites, all against a **real PostgreSQL server** — the concurrency and constraint behaviour under test is PostgreSQL semantics, so an emulator could not demonstrate it.

| Suite | Runner | Location | Result (last run) |
|---|---|---|---|
| Backend integration | `node --test` | `tests/` | **155 tests, 12 files — 155 pass** |
| Frontend UI | Vitest + jsdom + RTL | `qa-security-suite/phase3/` | **83 tests, 8 files — 83 pass** |
| QA security phases | Vitest | `qa-security-suite/phase1,2,4/` | see caveat below |

### Backend integration suite — `tests/` (12 files, 155 tests)

Each file gets a **fresh schema**: the harness drops and rebuilds it, then starts the real Express app on an ephemeral port. Tests drive the HTTP surface — cookies, CSRF, status codes — not the service functions, because the properties that matter are properties of the whole path.

| File | Proves |
|---|---|
| `p0-orders-atomicity.test.js` | 10 concurrent orders against 1 unit produce exactly 1 winner; 20 against 5 produce exactly 5; a multi-line order rolls back completely; retried idempotency keys converge on one order; duplicate lines merge; totals are exact |
| `p0-orders-lifecycle.test.js` | exact-stock boundary, auto-allocation, malformed input rejected pre-SQL, cancel restocks and records it, shipped orders cannot be cancelled, illegal transitions refused, Client isolation, full status history |
| `p0-schema-integrity.test.js` | raw SQL cannot create negative stock, negative money, zero-quantity lines, unknown roles or duplicate keys; RESTRICT protects referenced rows; money is `NUMERIC(14,2)`; time is `TIMESTAMPTZ`; every FK is indexed; the ledger sums to the quantity on hand |
| `p0-inventory.test.js` | first receipt creates the row, negative adjustments refused with real numbers, zero/non-integer deltas rejected, low-stock thresholds and filters, ledger history, exact stock valuation |
| `p0-rbac.test.js` | IDOR closed at both list and record level; Clients excluded from internal endpoints; role changes revoke live sessions; disabled accounts blocked; the last admin is protected; CSRF enforced for cookies and correctly skipped for Bearer; no email enumeration |
| `p0-users-delete.test.js` | permanent deletion is Admin-only; refused for self, for Admins and for active accounts; deactivated Client/Manager/Staff can be deleted; `token_version` bumped so live sessions die; warehouse grants released; history preserved |
| `p0-password-reset.test.js` | request returns the same body for real / unknown / disabled addresses; no mail to an ineligible address; the raw token is never stored (only its SHA-256); the link is built from `FRONTEND_URL` and ignores a spoofed `X-Forwarded-Host`; a new request retires the old link; validate reports `valid` without spending; empty token is a validation error; reset replaces the password and the old one stops working; no session cookie is set; the token burns (second use rejected); two concurrent submissions produce exactly one winner; existing sessions are revoked; a disabled account is neither reset nor re-enabled; role and warehouse grants are untouched; short password and mismatched confirmation rejected with the right field; malformed tokens never 500; the FK cascades; duplicate hashes refused; and a timing-ratio assertion that would catch a blocking SMTP send |
| `p0-password-reset-ratelimit.test.js` | with `RATE_LIMIT_ENABLED=true` set before the harness boots: a flood from one address gets `429 RATE_LIMITED` with a message that reveals nothing, and repeated link checks are throttled. Asserts the env actually took effect, so the test cannot pass vacuously |
| `p0-bulk-import.test.js` | product bulk import: header validation, per-row errors, duplicates, transaction behaviour |
| `p0-orders-bulkImport.test.js` | order bulk import over HTTP: idempotency, partial failure reporting, stock interaction |
| `unit-bulk-import.test.js` | `parseAndValidateProductsFile` in isolation |
| `unit-order-bulkImport.test.js` | `parseFileToRows` in isolation |

### Frontend UI suite — `qa-security-suite/phase3/` (8 files, 83 tests)

Every render goes through the same provider stack `main.jsx` uses (AuthProvider + MemoryRouter), with the network stubbed at `services/endpoints.js` — one layer *below* `AuthContext`, so the real context (hydration, the post-login `/me` call, the 401 handler) is still exercised.

| File | Tests | Proves |
|---|---|---|
| `password-reset-ui.test.jsx` | 21 | Login offers the "Forgot password?" link; `/forgot-password` renders heading, field and both actions; submitting shows the generic message verbatim for a real *and* an unknown address; a throttled request never claims a link was sent; the reset page shows "Verifying reset link…", renders **no form** for an invalid/missing/failed-check token, checks a valid link without spending it, sets `autocomplete="new-password"`; the two fields toggle independently without altering typed values; the strength meter and checklist render and never disable submit; short password and mismatch are blocked client-side; a successful reset reports success, calls no login endpoint, and does not flip back to "invalid" when the token is stripped from the URL; "Sign In Now" navigates to `/login`; a token spent mid-flight falls back to the invalid state; `evaluatePassword` unit cases |
| `password-visibility.test.jsx` | 8 | Sign-in password masks/unmasks, icon reflects state, toggling never clears the typed value, the toggle does not submit the form, and a normal sign-in still sends the exact credentials |
| `users.delete-ui.test.jsx` | 12 | Delete is offered for a deactivated Manager/Staff/Client but **never** for a still-active user or an administrator; Deactivate and Reactivate keep working alongside it; the confirmation names who is about to be removed; cancelling deletes nothing; confirming removes the row and reports success; a refusal keeps the account and explains why; the confirm button locks while the request is in flight; Delete disappears again once a user is reactivated |
| `products.category-filter-ui.test.jsx` | 6 | Every category renders up front with "All categories" highlighted; selecting one keeps the rail visible and highlights only it; the product list and its count filter down; selecting "All categories" restores everything; the rail stays stable while searching and composes with the Include-archived toggle; the category is restored from the URL |
| `products.archive-ui.test.jsx` | 2 | Toggling "Include archived" updates the list, the total, the URL and the archived-row appearance together; loading a URL that already carries the flag restores both the toggle and the filtered list |
| `register.validation.test.jsx` | 19 | Submission is **blocked** (message shown *and* the network never touched) for a password under 12 characters, one at exactly 11, over 72, and a malformed email; exactly 12 and exactly 72 are accepted, so the boundary is not stricter than documented; the password input is marked invalid for assistive technology, not only visually; mismatched confirmation and a too-short name are refused; all invalid fields are reported at once rather than one at a time; name and email are trimmed before sending; the password never leaks into the submitted name or email |
| `api-error-ui.test.jsx` | 14 | A 401/409/429/500/network failure produces a friendly banner **and the page stays usable** — the form is still present, the button is re-enabled, and a retry really reaches the API; a failed registration never signs the user in and offers a route to sign in instead; an error never reveals whether an email exists; the previous error clears on the next attempt; an error object with no message, and a 500, do not crash the app or leave it stuck loading; a successful sign-in navigates away and shows no banner |
| `orders.manager-ui.test.jsx` | 1 | A Manager sees both order actions and the new order is submitted against their assigned warehouse |

### QA security phases — `qa-security-suite/phase1,2,4/`

| Phase | Files | Focus |
|---|---|---|
| phase1 | `auth.integration.test.js`, `transactions.integration.test.js` | end-to-end auth and transactional behaviour over HTTP |
| phase2 | `acid-transactions.test.js`, `schema-integrity.test.js` | ACID properties and database-enforced invariants |
| phase4 | `cors-and-headers.test.js`, `rate-limiting.test.js`, `sql-injection.test.js`, `rbac.test.js` | transport security, throttling, injection resistance, authorisation |

> **Known open items in this suite.** Seven tests in phases 1/2/4 fail and have **not** been triaged: `schema-integrity` (duplicate warehouse name), `rbac` ×3 (the LAST_ADMIN fixture creates two admins; a forged token omits `tv`; a mass-assignment name case) and `sql-injection` ×3. Do **not** treat "the SQL-injection suite exists" as evidence that injection is proven safe until these are resolved. They are listed here rather than hidden.

### Running the tests

```bash
# Backend (needs a PostgreSQL to connect to; see TEST_DATABASE_URL below)
npm test                    # node --test, one process per file (preferred)
npm run test:inproc         # single process; for sandboxes that block child spawn

# Frontend UI suite
cd client && npm run qa:phase3
```

**The suite owns its database.** `tests/helpers/harness.js` ignores `DATABASE_URL` and uses the bundled server on `127.0.0.1:55432`, because `resetDatabase()` drops and rebuilds the schema — inheriting `.env` would wipe your seeded Docker database on every run. Set `TEST_DATABASE_URL` to point the suite at a specific server (CI, or a Docker database).

Running the backend suite **entirely inside Docker** against a scratch database (never the real one):

```bash
docker compose exec db psql -U bhautik -d postgres -c 'CREATE DATABASE stockpulse_qa;'   # once

docker compose run --rm -T --no-deps \
  -e TEST_DATABASE_URL="postgres://bhautik:bhautik@db:5432/stockpulse_qa" \
  -v "./tests:/app/tests:ro" -v "./scripts:/app/scripts:ro" \
  --entrypoint node server \
  --test --test-concurrency=1 /app/tests/<file>.test.js
```

Two operational notes learned the hard way: the harness imports `scripts/dev-db.js`, so `scripts/` must be mounted too; and running the suite **while another heavy container job is in flight** can make the harness's 1.5 s reachability probe time out, which fails one file's `before` hook and cancels its tests. Run it alone.

The frontend suite in Docker (Node image + a named volume for the Linux `node_modules`):

```bash
docker run --rm -v "${PWD}:/repo" -v stockpulse_client_nm:/repo/client/node_modules \
  -w /repo/client node:22-alpine sh -c "npm ci --no-audit --no-fund && npx vitest run"
```

Three real bugs were found and fixed by the backend suite during development — a parameter-type conflict that broke every cancellation (`SQLSTATE 42P08`), a mis-signed ledger entry on restock that made the ledger disagree with the quantity it explained, and an unmapped `23001` that turned "you cannot delete a warehouse that still holds stock" into a `500`.

---

## API reference

`GET /api` returns the endpoint index.

```
POST   /api/auth/register                    Client self-service sign-up
POST   /api/auth/login                       sets sp_token (HttpOnly) + sp_csrf
POST   /api/auth/logout[?all=true]           clear cookies, or revoke every session
GET    /api/auth/me                          identity + resolved warehouse scope

POST   /api/auth/forgot-password             → { message }   (always the same message)
POST   /api/auth/validate-reset-token        → { valid }     (does not spend the token)
POST   /api/auth/reset-password              spends the token, revokes sessions, no login

GET    /api/users                            Admin only
POST   /api/users                            Admin only — creates Admin/Manager/Staff/Client
PATCH  /api/users/:id                        role change revokes existing sessions
POST   /api/users/:id/warehouse-access
DELETE /api/users/:id                        Admin only — soft delete, deactivated non-admins

GET    /api/admin/overview                   Admin only
GET    /api/admin/users
GET    /api/admin/users/:id

GET    /api/catalog                          Client-facing: aggregate availability only
GET    /api/catalog/:id
GET    /api/products                         internal catalogue (Admin/Manager)
POST   /api/products                         unique SKUs, case-insensitive
POST   /api/products/bulk-import             CSV/XLSX upload
PATCH  /api/products/:id
DELETE /api/products/:id                     soft delete (archives)

GET    /api/warehouses                       scoped
POST   /api/warehouses
GET    /api/warehouses/:id
PATCH  /api/warehouses/:id
GET    /api/warehouses/:id/inventory         scoped — 403 out of scope
GET    /api/warehouses/:id/ledger
GET    /api/warehouses/:id/orders            fulfilment queue

GET    /api/inventory                        filters: warehouse, product, low_stock, search
GET    /api/inventory/low-stock              per-warehouse thresholds, worst first
GET    /api/inventory/ledger                 every movement, with its reason and origin
POST   /api/inventory/adjust                 signed delta; zero and overdraws refused

POST   /api/orders                           Idempotency-Key header supported
GET    /api/orders                           own / scoped / all
GET    /api/orders/:id
POST   /api/orders/:id/cancel                the only cancellation path (restocks)
PATCH  /api/orders/:id/status                Processing → Shipped → Delivered
POST   /api/orders/bulk-import               CSV/XLSX upload, Idempotency-Key supported

GET    /api/analytics/summary | /sales-trend | /top-products | /by-warehouse
```

---

## Configuration

Validated at boot by `src/config/env.js`; the process refuses to start on invalid configuration rather than failing later under load.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | required; `postgres://bhautik:bhautik@127.0.0.1:5432/StockPulse` for the Compose stack |
| `DATABASE_URL1` | — | the value Compose forwards to the `server` container (host `db`) |
| `TEST_DATABASE_URL` | bundled server | where `npm test` connects; override in CI |
| `JWT_SECRET` | — | required, ≥ 32 characters |
| `JWT_TTL` | `15m` | cookie lifetime tracks it |
| `COOKIE_NAME` / `CSRF_COOKIE_NAME` | `sp_token` / `sp_csrf` | |
| `COOKIE_SECURE` | `false` | set `true` behind HTTPS |
| `BCRYPT_ROUNDS` | `12` | ≥ 10 enforced outside tests |
| `DB_POOL_MAX` | `10` | raise for concurrency testing |
| `DB_STATEMENT_TIMEOUT_MS` | `10000` | |
| `DB_LOCK_TIMEOUT_MS` | `5000` | a blocked row lock fails as `409` |
| `DB_POOL_ACQUIRE_TIMEOUT_MS` | `5000` | |
| `CORS_ORIGIN` | `http://localhost:5173` | comma-separated |
| `RATE_LIMIT_ENABLED` | on unless `NODE_ENV=test` | |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `900000` / `10` | login limiter |
| `ORDER_MAX_LINES` | `200` | per order |
| `ORDER_MAX_QUANTITY_PER_LINE` | `100000` | |
| `LOG_LEVEL` | `info` | `silent` in tests |
| `PG_PORT` / `PG_DATABASE` / `PG_USER` | `55432` / `stockpulse` / `postgres` | bundled server only |

### Password reset and email

| Variable | Default | Notes |
|---|---|---|
| `FRONTEND_URL` | `http://localhost:5173` | **the trusted base for the emailed link.** Never derived from a request header. No trailing slash |
| `RESET_TOKEN_TTL_MINUTES` | `30` | link lifetime |
| `EMAIL_USER` | — | Gmail address. Optional: the API boots without it and logs mail as undelivered |
| `EMAIL_PASS` | — | a **Google App Password**, not the account password — Gmail rejects plain-password SMTP auth |
| `EMAIL_FROM` | `StockPulse <EMAIL_USER>` | |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | `smtp.gmail.com` / `465` / `true` | |
| `RESET_RATE_IP_MAX` / `RESET_RATE_IP_WINDOW_MS` | `5` / `900000` | per caller address |
| `RESET_RATE_ACCOUNT_MAX` / `RESET_RATE_ACCOUNT_WINDOW_MS` | `3` / `3600000` | per targeted account |

### Scripts

| Command | Does |
|---|---|
| `npm start` / `npm run dev` | run the API (dev adds `--watch`) |
| `npm run migrate` | apply pending migrations (`--fresh` drops the schema first — never on real data) |
| `npm run seed` | idempotent demo data |
| `npm run reset` | `migrate --fresh` + `seed` |
| `npm test` / `npm run test:inproc` | backend suite |
| `npm run db:up` / `db:down` | bundled PostgreSQL (`scripts/dev-db.js`) |
| `npm run db:docker` / `db:docker:down` / `db:docker:logs` | Compose database + Adminer |
| `cd client && npm run dev` / `build` / `qa:phase3` | SPA dev server, production build, UI suite |

---

## Known limitations / what comes next

Honest gaps, in priority order:

1. **Bootstrap.** The first Admin is created by the seed script, not an endpoint — deliberate, but it means a fresh deployment needs a documented runbook step.
2. **No reservations.** Stock is consumed at order placement, so a `Pending` order already holds inventory. Reservations with confirm/release are the next correctness improvement.
3. **Automatic allocation never splits a line** across warehouses. The schema supports split shipments (`order_items.warehouse_id` per line); the allocator simply picks one warehouse today.
4. **No purchase orders or suppliers**, so inventory can only be increased by manual adjustment or bulk import. This is the highest-value business feature still missing.
5. **No refresh tokens.** A 15-minute session and global revocation via `token_version`; rotation and a denylist are the natural upgrade.
6. **No transfer, returns/RMA, batch/lot or expiry tracking.**
7. **Single currency** (`USD`); the column exists but conversion does not.
8. **Password reset is the only self-service account flow.** No email verification on signup, no 2FA, no password-reuse history, and no admin audit UI for reset events (the rows are retained in `password_reset_tokens` and could back one).
9. **SMTP credentials live in `.env`**, so they are readable via `docker inspect`. Docker secrets or a managed email provider is the production-grade replacement.
10. **Known failing tests in `qa-security-suite` phases 1/2/4** (see [Test cases](#test-cases)) are untriaged.
11. A leftover `console.log('DEBUG RUNTIME DATABASE_URL:', …)` in `src/db/pool.js` prints database connection diagnostics on every boot. It is an information-disclosure and log-noise item that should be removed.

### Suggested next milestone (P1)

Reservations and backorders → suppliers and purchase orders → containerise the API and add CI that runs `migrate` + `test` on every push → triage the phase 1/2/4 failures → move SMTP credentials to Docker secrets.
