# StockPulse

**Enterprise B2B multi-warehouse inventory & supply chain management system.**

StockPulse is built around one promise: **an order either happens completely or not at all, and no sequence of concurrent requests can ever oversell stock.** This document describes the P0 foundation that makes that promise true, and the database-level guarantees that hold even when application code is wrong.

---

## Table of contents

- [Quick start](#quick-start)
- [What P0 delivered](#what-p0-delivered)
- [Architecture](#architecture)
- [The order transaction](#the-order-transaction)
- [Schema corrections](#schema-corrections)
- [Authorisation model](#authorisation-model)
- [Security decisions](#security-decisions)
- [Money, time and errors](#money-time-and-errors)
- [Running the tests](#running-the-tests)
- [API reference](#api-reference)
- [Configuration](#configuration)
- [Known limitations / what comes next](#known-limitations--what-comes-next)

---

## Quick start

```bash
cp .env.example .env          # provides the local Compose configuration

docker compose up -d --build --wait
docker compose exec server npm run migrate
docker compose exec server npm run seed
```

| | |
|---|---|
| Frontend | http://localhost:5173 |
| API | http://localhost:5000 |
| Adminer (database UI) | http://localhost:8080 — server `db`, user `bhautik`, password `bhautik`, database `StockPulse` |
| Database | `localhost:5432` — from the app: `postgres://bhautik:bhautik@127.0.0.1:5432/StockPulse` |

Check it is alive, then sign in and place an order (the seed prints all demo
accounts):

```bash
curl -s localhost:5000/health

curl -s -X POST localhost:5000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"client@acme.dev","password":"ClientPass1234"}'
```

### Two things worth knowing

- **The database name is case-sensitive.** Compose creates `StockPulse`, and
  PostgreSQL will not find `stockpulse`. The name is created quoted
  (`CREATE DATABASE "StockPulse"`), so those capitals are real and must appear in
  `DATABASE_URL` exactly. Prefer lowercase? Change `POSTGRES_DB` in `.env`,
  then run `docker compose down -v`
  (which deletes the data directory) before starting again.
- **The data lives in `./.pgdata`** on the host, exactly where your Compose file
  put it, and it is git-ignored. `docker compose down` keeps it;
  `docker compose down -v` does not — with a bind mount, only removing
  `./.pgdata` itself actually deletes it.

> **Why `PGDATA` is set explicitly.** The official `postgres:18` image moved its
> default data directory to `/var/lib/postgresql/18/docker` and declares its
> volume at `/var/lib/postgresql`. Naming `PGDATA` inside the bind mount keeps it
> meaningful on 16, 17 and 18 alike.

### Without Docker

The project also ships a real PostgreSQL server in `node_modules`
(`@embedded-postgres`), which needs no install and no daemon:

```bash
# swap the DATABASE_URL line in .env for the bundled one, then:
npm run db:up
```

`npm run db:up` starts a genuine PostgreSQL 18 server from the binaries under
`node_modules/@embedded-postgres/<platform>/native/bin`, bound to `127.0.0.1:55432`
only, and creates the database if it does not exist. If `DATABASE_URL` points at
some other server, the script **never** starts a second one behind your back: if
that server is reachable it does nothing, and if it is not it fails with
instructions rather than leaving the app connected to nothing.

> **Why a real server and not an embedded emulator:** the guarantees this project
> makes are PostgreSQL semantics — row-lock re-evaluation under `READ COMMITTED`
> and atomic conditional `UPDATE`. An in-memory emulator cannot demonstrate them,
> so it could not defend the central claim.

---

## What P0 delivered

P0 was defined as *trust and correctness* — the layer everything else stands on.

| P0 item | Status | Where |
|---|---|---|
| Atomic conditional decrement, deterministic lock order, rollback verification | done | `src/modules/orders/orders.service.js`, `orders.repository.js` |
| Warehouse linkage on order lines (per-line fulfilment) | done | `src/db/migrations/001_init.sql` (`order_items.warehouse_id`) |
| RBAC data scoping (IDOR closed) | done | `src/middleware/authorize.js`, `src/lib/warehouseScope.js` |
| Corrected schema: CHECKs, FKs, indexes, `TIMESTAMPTZ`, money as `NUMERIC` | done | `src/db/migrations/001_init.sql` |
| Idempotent order creation | done | `orders.service.js` + `orders.idempotency_key` |
| Append-only stock ledger | done | `inventory_transactions` |
| Migrations + seed + graceful shutdown | done | `src/db/`, `src/index.js` |
| Test suite proving the above | done | `tests/` — 59 assertions-level cases |

Deliberately **out of P0**, tracked for later: reservations/backorders, purchase
orders and suppliers, stock transfers, returns/RMA, forecasting, the React
frontend, multi-tenancy. See [what comes next](#known-limitations--what-comes-next).

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
  lib/                     logger, password, tokens, CSRF, scope helpers, schemas
  middleware/              asyncHandler, errorHandler, validate, authenticate, authorize
  modules/
    auth/                  register, login, logout, me, user administration
    products/              internal catalogue + Client-facing catalogue
    warehouses/            warehouse CRUD, nested ledger and fulfilment queue
    inventory/             stock listing, low stock, adjustments, ledger
    orders/                ← the P0 centrepiece
    analytics/             dashboard metrics, trends, breakdowns
  app.js                   Express assembly
  index.js                 bootstrap + graceful shutdown
```

Layering, applied consistently:

```
HTTP        routes      → validate input, delegate, shape the response
Business    service     → rules, transaction boundaries, authorisation decisions
Persistence repository  → SQL
```

Repositories are used where the SQL **is** the business rule (orders, inventory,
users). For simple CRUD domains (warehouses, products) the SQL lives in the
service — a separate file that only forwards a query adds indirection without
adding clarity.

---

## The order transaction

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

Under `READ COMMITTED`, if another transaction has already committed a
decrement, this statement waits on the row lock and then **re-evaluates the
predicate against the new value**. Either it updates, or the row is skipped and
`rowCount` comes up short — in which case the whole transaction is rolled back
and the client receives a `409` naming exactly which line fell short and by how
much.

A read-then-write implementation (`SELECT quantity`, check in JavaScript, then
`UPDATE`) cannot offer this guarantee at any isolation level below
`SERIALIZABLE`. That is the difference between "uses transactions" and "cannot
oversell".

### Supporting decisions

- **Lock ordering.** `lockInventoryRows` sorts by `(product_id, warehouse_id)`
  before touching anything. Two orders touching products `{1,2}` and `{2,1}` would
  otherwise be able to deadlock.
- **Duplicate lines are merged.** `UPDATE ... FROM` with two source rows matching
  one target updates it *once*, with an unpredictable winner. An unmerged payload
  of `[{A,3},{A,4}]` could consume 3 or 4; merging makes it exactly 7.
- **Totals are computed server-side** from stored prices in `NUMERIC` arithmetic.
  A client-supplied `total_amount` is stripped by the validator and never read.
- **Cancellation is a separate endpoint.** `PATCH /api/orders/:id/status` refuses
  `Cancelled` outright, because cancellation also restocks and writes a ledger
  row. One cancellation path means an order can never be cancelled without its
  stock coming back.
- **Everything is attributed.** Every quantity change writes an
  `inventory_transactions` row with a reason (`receipt`, `sale`, `adjustment`,
  `restock`) and an actor.

---

## Schema corrections

The original draft DDL was a reasonable start but stored several business rules
nowhere, and left the order-to-warehouse relationship unmodelled. Every fix below
is enforced by PostgreSQL, not by convention. Full annotated list in
`src/db/migrations/001_init.sql`.

### Correctness

| # | Problem in the draft | Fix |
|---|---|---|
| 1 | `role CHECK (… 'Admin','Manager','Staff')` while the spec described a *Client* buyer — a `VARCHAR` CHECK only fails at runtime | `Client` added as a first-class role |
| 2 | A demoted Admin kept Admin rights until their token expired | `users.token_version`; bumping it invalidates every issued token |
| 3 | `UNIQUE(email)` allowed `Ada@x.com` and `ada@x.com` as separate accounts | unique index on `lower(email)` |
| 4 | `manager_id … ON DELETE SET NULL` silently orphaned warehouses | `ON DELETE RESTRICT` + soft delete |
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

Two reporting views (`low_stock`, `product_stock_totals`) make the per-warehouse
threshold logic a single source of truth rather than something each query
reinvents.

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

The scope is **data, not a boolean** (`{ all: true }` or `{ all: false, ids: [] }`)
so it is pushed straight into SQL:

```js
const clause = warehouseScopeClause(req.warehouseScope, 'i.warehouse_id', params);
// -> 'i.warehouse_id = ANY($1::int[])'     or 'FALSE' when the scope is empty
```

An unauthorised row is never read out of the database at all, and an empty scope
yields `FALSE` — the system fails **closed**.

Two details worth calling out:

- **Out-of-scope single records return `404`, not `403`.** A `403` confirms the id
  exists, which lets someone enumerate other customers' orders.
- **Analytics are genuinely scoped.** A Manager's revenue is the value of lines in
  *their* warehouses, not the total of orders that happen to touch them.

---

## Security decisions

- **JWT in an HttpOnly cookie** (`sp_token`) so an XSS bug cannot exfiltrate the
  session, plus `Authorization: Bearer` for Postman/CI/device clients.
- **CSRF double-submit**, bound to cookie authentication: the check lives inside
  the authentication middleware, so a new route *cannot* forget it. A readable
  `sp_csrf` cookie must be echoed in `X-CSRF-Token` on state-changing calls.
  Bearer requests are exempt — nothing attaches them ambiently.
- **Role is re-read from the database on every request** rather than trusted from
  the token payload. Privilege changes and deactivation therefore take effect on
  the next request instead of when the token expires.
- **Public registration can only create a `Client`.** The validator strips unknown
  fields, so sending `role: "Admin"` achieves nothing. Internal accounts are
  created by an Admin via `POST /api/users`.
- **No user enumeration.** An unknown email still costs a bcrypt comparison
  against a dummy hash, so timing and messages are identical to a wrong password.
- **The last active administrator cannot be demoted or disabled** — there is no
  in-app recovery from a system with no admin.
- **Login rate limiting** (`express-rate-limit`), Helmet, an explicit CORS origin
  list with credentials, and a bounded JSON body.
- **Server-side timeouts** (`statement_timeout`, `lock_timeout`, pool acquire
  timeout) so one stuck query cannot hold a pool slot forever. `/health` reports
  pool saturation, because "healthy" while every connection is checked out is the
  state that precedes collapse.

---

## Money, time and errors

- **Money is `NUMERIC`, never a float**, and arrives in JSON as a **string**
  (`"498.00"`). `0.1 + 0.2 !== 0.3` in IEEE-754; summing invoices in JavaScript is
  a defect, not a rounding preference. All arithmetic happens in SQL.
  (Tested: `3 × 0.10 → "0.30"`.)
- **Prices** are validated to at most 2 decimal places at the boundary rather than
  silently rounded by the database, and normalised to an exact decimal string.
- **Time is `TIMESTAMPTZ`.** Day buckets are computed in an explicit timezone and
  **gap days are filled with zeros**, so a chart cannot imply revenue on a day
  that had none.
- **Errors have one shape**, with a machine-readable code:

  ```json
  { "error": { "code": "INSUFFICIENT_STOCK", "message": "…",
               "details": { "lines": [ { "product_id": 7, "warehouse_id": 1,
                                         "requested": 5, "available": 1 } ] },
               "requestId": "…" } }
  ```

  Refusals are specific: telling a client *which line* fell short and *by how
  much* is the difference between a usable API and a guessing game.

---

## Running the tests

```bash
npm test              # node --test, one process per file (preferred)
npm run test:inproc   # single process; for sandboxes that block child spawn
```

59 tests across five suites. They run against a **real PostgreSQL server**, which
the harness starts and rebuilds from scratch for each file.

**The suite owns its database.** It ignores `DATABASE_URL` and uses the bundled
server on `127.0.0.1:55432`, because `resetDatabase()` drops and rebuilds the
schema — inheriting `.env` would wipe your seeded Docker database on every run.
Set `TEST_DATABASE_URL` to point the suite at a specific server (CI, for example).

| Suite | Proves |
|---|---|
| `p0-orders-atomicity` | 10 concurrent orders against 1 unit produce exactly 1 winner; 20 against 5 produce exactly 5; a multi-line order rolls back completely; retried idempotency keys converge on one order; duplicate lines merge; totals are exact |
| `p0-orders-lifecycle` | exact-stock boundary, auto-allocation, malformed input rejected pre-SQL, cancel restocks and records it, shipped orders cannot be cancelled, illegal transitions refused, Client isolation, full status history |
| `p0-schema-integrity` | raw SQL cannot create negative stock, negative money, zero-quantity lines, unknown roles or duplicate keys; RESTRICT protects referenced rows; money is `NUMERIC(14,2)`; time is `TIMESTAMPTZ`; every FK is indexed; the ledger sums to the quantity on hand |
| `p0-inventory` | first receipt creates the row, negative adjustments refused with real numbers, zero/non-integer deltas rejected, low-stock thresholds and filters, ledger history, exact stock valuation |
| `p0-rbac` | IDOR is closed at both list and record level; Clients are outside internal endpoints; role changes revoke live sessions; disabled accounts are blocked; the last admin is protected; CSRF enforced for cookies and correctly skipped for Bearer; no email enumeration |

Three real bugs were found and fixed by this suite during development — a
parameter-type conflict that broke every cancellation (`SQLSTATE 42P08`), a
mis-signed ledger entry on restock that made the ledger disagree with the
quantity it explained, and an unmapped `23001` that turned "you cannot delete a
warehouse that still holds stock" into a `500`.

---

## API reference

`GET /api` returns the endpoint index. Highlights:

```
POST   /api/auth/register            Client self-service sign-up
POST   /api/auth/login               sets sp_token (HttpOnly) + sp_csrf
POST   /api/auth/logout[?all=true]   clear cookies, or revoke every session
GET    /api/auth/me                  identity + resolved warehouse scope

GET    /api/users                    Admin only
POST   /api/users                    Admin only — creates Admin/Manager/Staff/Client
PATCH  /api/users/:id                role change revokes existing sessions
POST   /api/users/:id/warehouse-access

GET    /api/catalog                  Client-facing: aggregate availability only
GET    /api/products                 internal catalogue
POST   /api/products                 unique SKUs, case-insensitive
DELETE /api/products/:id             soft delete (archives)

GET    /api/warehouses               scoped
GET    /api/warehouses/:id/inventory scoped — 403 out of scope
GET    /api/warehouses/:id/ledger
GET    /api/warehouses/:id/orders    fulfilment queue

GET    /api/inventory                filters: warehouse, product, low_stock, search
GET    /api/inventory/low-stock      per-warehouse thresholds, worst first
GET    /api/inventory/ledger         every movement, with its reason and origin
POST   /api/inventory/adjust         signed delta; zero and overdraws refused

POST   /api/orders                   Idempotency-Key header supported
GET    /api/orders                   own / scoped / all
GET    /api/orders/:id
POST   /api/orders/:id/cancel        the only cancellation path (restocks)
PATCH  /api/orders/:id/status        Processing → Shipped → Delivered

GET    /api/analytics/summary | /sales-trend | /top-products | /by-warehouse
```

---

## Configuration

Validated at boot by `src/config/env.js`; the process refuses to start on invalid
configuration rather than failing later under load.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | required; `postgres://bhautik:bhautik@127.0.0.1:5432/StockPulse` for the Compose stack |
| `TEST_DATABASE_URL` | bundled server | where `npm test` connects; override in CI |
| `JWT_SECRET` | — | required, ≥ 32 characters |
| `JWT_TTL` | `15m` | cookie lifetime tracks it |
| `BCRYPT_ROUNDS` | `12` | ≥ 10 enforced outside tests |
| `DB_POOL_MAX` | `10` | raise for concurrency testing |
| `DB_STATEMENT_TIMEOUT_MS` | `10000` | |
| `DB_LOCK_TIMEOUT_MS` | `5000` | a blocked row lock fails as `409` |
| `CORS_ORIGIN` | `http://localhost:5173` | comma-separated |
| `ORDER_MAX_LINES` | `200` | per order |
| `ORDER_MAX_QUANTITY_PER_LINE` | `100000` | |
| `LOG_LEVEL` | `info` | `silent` in tests |
| `PG_PORT` / `PG_DATABASE` / `PG_USER` | `55432` / `stockpulse` / `postgres` | bundled server only |

### Database scripts

| Command | Does |
|---|---|
| `npm run db:docker` | `docker compose up -d --wait` — PostgreSQL + Adminer, waits until ready |
| `npm run db:docker:logs` | follow the PostgreSQL log |
| `npm run db:docker:down` | stop the containers (data in `./data/db` is kept) |
| `npm run db:up` | start the *bundled* PostgreSQL, or step aside if `DATABASE_URL` is already reachable |
| `npm run db:down` | stop the bundled PostgreSQL; refuses to touch a database it does not manage |

---

## Known limitations / what comes next

Honest gaps, in priority order:

1. **Bootstrap.** The first Admin is created by the seed script, not an endpoint —
   deliberate, but it means a fresh deployment needs a documented runbook step.
2. **No reservations.** Stock is consumed at order placement, so a `Pending` order
   already holds inventory. Reservations with confirm/release are the next
   correctness improvement.
3. **Automatic allocation never splits a line** across warehouses. The schema
   supports split shipments (`order_items.warehouse_id` per line); the allocator
   simply picks one warehouse today.
4. **No purchase orders or suppliers**, so inventory can only be increased by
   manual adjustment. This is the highest-value business feature still missing.
5. **No frontend.** The React/Vite client is not part of P0.
6. **No refresh tokens.** A 15-minute session and global revocation via
   `token_version`; rotation and a denylist are the natural upgrade.
7. **No transfer, returns/RMA, batch/lot or expiry tracking.**
8. **Single currency** (`USD`); the column exists but conversion does not.

### Suggested next milestone (P1)

Reservations and backorders → suppliers and purchase orders → containerise the
API and add CI that runs `migrate` + `test` on every push → the React dashboard
consuming the analytics endpoints that already exist.