# StockPulse — Production Deployment Guide

**Full-Stack B2B Inventory Management Application**  
Frontend: React + Vite + Tailwind CSS + shadcn/ui → **Vercel**  
Backend: Node.js + Express.js + PostgreSQL (`pg`) → **Render**  
Database: PostgreSQL → **Supabase**

---

## Table of Contents

1. [Database Setup (Supabase)](#1-database-setup-supabase)
2. [Backend Code Adjustments & Render Deployment](#2-backend-code-adjustments--render-deployment)
3. [Frontend Configuration & Vercel Deployment](#3-frontend-configuration--vercel-deployment)
4. [Integration & Verification](#4-integration--verification)
5. [Troubleshooting Common Issues](#5-troubleshooting-common-issues)

---

## 1. Database Setup (Supabase)

### 1.1 Create a Supabase Project

1. Go to [supabase.com](https://supabase.com) and sign in / sign up.
2. Click **New Project**.
3. Choose your organization, enter a project name (e.g., `stockpulse-prod`), and set a **strong database password**.
4. Select a region close to your Render deployment region (e.g., `US East (N. Virginia)` for Render's Ohio region).
5. Click **Create new project**. Wait for provisioning (~2 minutes).

### 1.2 Configure Database Schema & Migrations

StockPulse uses a forward-only migration runner (`src/db/migrate.js`). The schema lives in `src/db/migrations/001_init.sql`.

**Option A: Run Migrations Locally Against Supabase (Recommended)**

```bash
# 1. Clone the repo locally (if not already)
git clone <your-repo-url>
cd stockpulse

# 2. Copy env example and fill in Supabase credentials
cp .env.example .env

# 3. Edit .env with your Supabase Transaction Pooler URL (see §1.3)
# DATABASE_URL=postgres://postgres:[PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres

# 4. Run migrations
npm run migrate

# 5. (Optional) Seed demo data
npm run seed
```

**Option B: Run Migrations via Supabase SQL Editor**

1. In Supabase Dashboard → **SQL Editor** → **New Query**.
2. Copy the entire contents of `src/db/migrations/001_init.sql`.
3. Paste and **Run**. This creates all tables, indexes, constraints, triggers, and views.
4. (Optional) Run the seed data by copying `src/db/seed.js` logic into SQL or run locally with `DATABASE_URL` pointing to Supabase.

> **Note:** The migration runner tracks applied migrations in a `schema_migrations` table with checksums. Running via SQL Editor is fine for initial setup; subsequent deploys should use the migration runner (e.g., in a CI step or Render `preDeploy` command).

### 1.3 Get the Correct Transaction Pooler URL (Port 6543)

**Why Port 6543?**  
Render's outbound IPv6 routing can cause `ENETUNREACH` errors when connecting to Supabase's direct IPv6 endpoint. The **Transaction Pooler (port 6543)** forces IPv4 routing and is the recommended connection method for serverless/containerized backends.

**Steps:**

1. In Supabase Dashboard → **Settings** → **Database**.
2. Scroll to **Connection Pooling**.
3. Ensure **Transaction** mode is selected (not Session).
4. Copy the **Transaction Pooler** connection string. It looks like:
   ```
   postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres
   ```
   - Host: `aws-0-[region].pooler.supabase.com`
   - Port: `6543`
   - Database: `postgres`
   - User: `postgres.[project-ref]`
   - Password: **your database password** (set during project creation)

### 1.4 URL-Encoding Rules for Special Characters in Passwords

If your database password contains special characters, **you must URL-encode them** in the `DATABASE_URL`.

| Character | Encoded As |
|-----------|------------|
| `@`       | `%40`      |
| `:`       | `%3A`      |
| `/`       | `%2F`      |
| `?`       | `%3F`      |
| `#`       | `%23`      |
| `[`       | `%5B`      |
| `]`       | `%5D`      |
| ` ` (space) | `%20`    |
| `!`       | `%21`      |
| `$`       | `%24`      |
| `&`       | `%26`      |
| `'`       | `%27`      |
| `(`       | `%28`      |
| `)`       | `%29`      |
| `*`       | `%2A`      |
| `+`       | `%2B`      |
| `,`       | `%2C`      |
| `;`       | `%3B`      |
| `=`       | `%3D`      |
| `%`       | `%25`      |

**Example:**  
Password: `P@ss:w0rd!` → Encoded: `P%40ss%3Aw0rd%21`  
Full URL: `postgres://postgres.abcdef:P%40ss%3Aw0rd%21@aws-0-us-east-1.pooler.supabase.com:6543/postgres`

> **Tip:** Use a URL encoder tool (e.g., `encodeURIComponent()` in browser console) to be safe.

---

## 2. Backend Code Adjustments & Render Deployment

### 2.1 Required Code Changes in `src/db/pool.js`

The pool configuration **must** include `family: 4` and `ssl: { rejectUnauthorized: false }` for Render deployments.

**Current `src/db/pool.js` (lines 22–34) — already correct:**

```js
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: env.DB_POOL_ACQUIRE_TIMEOUT_MS,
  statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
  lock_timeout: env.DB_LOCK_TIMEOUT_MS,
  application_name: 'stockpulse-api',
  family: 4, // <-- Forces IPv4 to fix Render's ENETUNREACH cloud deployment crash
  ssl: {
    rejectUnauthorized: false // <-- This fixes the self-signed certificate error
  }
});
```

**Explanation:**

| Setting | Purpose |
|---------|---------|
| `family: 4` | Forces Node's DNS resolver to use IPv4 only. Render's IPv6 egress causes `ENETUNREACH` to Supabase. |
| `ssl: { rejectUnauthorized: false }` | Supabase's pooler uses a self-signed CA. Without this, `node-postgres` throws `SELF_SIGNED_CERT_IN_CHAIN`. |

> **Do not remove these.** They are production requirements for Render + Supabase.

### 2.2 Create a Web Service on Render

#### Prerequisites

- GitHub/GitLab/Bitbucket repo with your `stockpulse` code.
- Supabase project with migrations applied (§1.2).
- `DATABASE_URL` ready (Transaction Pooler, URL-encoded password).

#### Step-by-Step Render Setup

1. **Log in to [Render Dashboard](https://dashboard.render.com).**
2. Click **New +** → **Web Service**.
3. **Connect Repository**: Select your `stockpulse` repo.
4. **Configure Service**:
   - **Name**: `stockpulse-api` (or your choice)
   - **Region**: Choose closest to your Supabase region (e.g., `Ohio (US East)` for `us-east-1` Supabase)
   - **Branch**: `main` (or your production branch)
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node src/index.js`
     > **Note:** `src/index.js` runs migrations automatically on startup via `await migrate()`. No separate migrate command needed.
   - **Instance Type**: `Free` (for testing) or `Starter`+` for production.

5. **Environment Variables** (click **Advanced** → **Add Environment Variable**):

| Key | Value | Notes |
|-----|-------|-------|
| `DATABASE_URL` | `postgres://postgres.[ref]:[encoded-pwd]@aws-0-[region].pooler.supabase.com:6543/postgres` | **Secret** — click the lock icon. |
| `JWT_SECRET` | `your-64-char-random-string` | **Secret** — generate with `openssl rand -base64 48`. Must be ≥32 chars. |
| `NODE_ENV` | `production` | Required for `family: 4` and `trust proxy` logic. |
| `CORS_ORIGIN` | `https://your-vercel-app.vercel.app` | Comma-separated if multiple. Must match frontend origin exactly. |
| `COOKIE_SECURE` | `true` | Required for HTTPS (Vercel + Render are HTTPS). |
| `LOG_LEVEL` | `info` | Or `warn` for less noise. |
| `PORT` | `10000` | Render assigns `PORT` env var automatically; this is a fallback. |

> **Important:** Render **automatically injects `PORT`**. The app reads `env.PORT` (default 4000). No need to set `PORT` manually unless you want a specific value.

6. **Click "Create Web Service"**.
7. Wait for build & deploy (2–5 minutes). Check logs for:
   - `database schema already up to date` or `database migrations applied`
   - `stockpulse api listening` on port
   - No `ENETUNREACH` or `SELF_SIGNED_CERT_IN_CHAIN` errors.

8. **Note your Render URL**: `https://stockpulse-api.onrender.com` (or custom subdomain).

### 2.3 Verify Backend Health

```bash
curl https://stockpulse-api.onrender.com/health
```

Expected response:
```json
{
  "status": "ok",
  "database": { "ok": true, "latencyMs": 12 },
  "pool": { "total": 1, "idle": 1, "waiting": 0, "max": 10 },
  "uptime_seconds": 45,
  "version": "0.1.0"
}
```

---

## 3. Frontend Configuration & Vercel Deployment

### 3.1 Configure `vercel.json` for SPA Routing

The `client/vercel.json` **must** have rewrite rules to prevent 404 on page refresh.

**Current `client/vercel.json` — already correct:**

```json
{
  "rewrites": [
    {
      "source": "/(.*)",
      "destination": "/index.html"
    }
  ]
}
```

This ensures all routes (`/dashboard`, `/orders/123`, etc.) serve `index.html`, letting React Router handle client-side navigation.

### 3.2 Configure API Base URL in Frontend

The frontend reads `VITE_API_URL` at build time (via `import.meta.env.VITE_API_URL` in `client/src/services/api.js`).

**For production, it must point to your Render backend + `/api`:**

```
https://stockpulse-api.onrender.com/api
```

> **Do not include a trailing slash.** The API client appends paths like `/auth/login`.

### 3.3 Deploy to Vercel

#### Prerequisites

- GitHub/GitLab/Bitbucket repo with `stockpulse` (frontend in `client/`).
- Render backend URL ready (§2.2).

#### Step-by-Step Vercel Setup

1. **Log in to [Vercel Dashboard](https://vercel.com/dashboard).**
2. Click **Add New...** → **Project**.
3. **Import Repository**: Select your `stockpulse` repo.
4. **Configure Project**:
   - **Framework Preset**: `Vite`
   - **Root Directory**: `client` ← **Critical!** The frontend lives in `client/`.
   - **Build Command**: `npm run build` (auto-detected)
   - **Output Directory**: `dist` (auto-detected)
   - **Install Command**: `npm install` (auto-detected)

5. **Environment Variables** (expand **Environment Variables** section):

| Name | Value | Environment |
|------|-------|-------------|
| `VITE_API_URL` | `https://stockpulse-api.onrender.com/api` | Production, Preview, Development |

> **Note:** `VITE_` prefix is required for Vite to expose the variable to client code.

6. **Click "Deploy"**.
7. Wait for build (1–3 minutes). Vercel will:
   - Run `npm install` in `client/`
   - Run `npm run build` → outputs to `client/dist/`
   - Deploy static assets to CDN
   - Apply `vercel.json` rewrites

8. **Note your Vercel URL**: `https://stockpulse.vercel.app` (or custom domain).

### 3.4 Update Render CORS_ORIGIN with Vercel URL

After Vercel deployment, update the Render backend's `CORS_ORIGIN`:

1. Go to Render Dashboard → `stockpulse-api` → **Environment**.
2. Edit `CORS_ORIGIN` to your Vercel URL:
   ```
   https://stockpulse.vercel.app
   ```
   (Add `,https://staging-stockpulse.vercel.app` for preview deployments if needed.)
3. **Save Changes** → Render will auto-redeploy.

---

## 4. Integration & Verification

### 4.1 Full Stack Connectivity Test

#### 4.1.1 Health Check Chain

```bash
# 1. Backend health
curl https://stockpulse-api.onrender.com/health

# 2. Frontend loads
curl -I https://stockpulse.vercel.app
# Should return 200 OK, content-type: text/html

# 3. Frontend → Backend API call (via browser DevTools)
# Open https://stockpulse.vercel.app, open DevTools → Network, sign in
# Verify requests go to https://stockpulse-api.onrender.com/api/...
```

#### 4.1.2 Authentication Flow Test

1. Open `https://stockpulse.vercel.app`.
2. You should see the login page (React app loaded).
3. Sign in with seeded demo credentials (from `npm run seed` output):
   - **Admin**: `admin@stockpulse.dev` / `AdminPass1234`
   - **Client**: `client@acme.dev` / `ClientPass1234`
4. Verify:
   - Login succeeds (cookie `sp_token` set, `HttpOnly`, `Secure`, `SameSite=Lax`).
   - `sp_csrf` cookie set (readable, for CSRF double-submit).
   - Redirect to dashboard / catalogue.
   - API calls in Network tab show `200 OK` with JSON data.

#### 4.1.3 Database Write Test

1. As Admin, create a new **Warehouse** → verify it appears in list.
2. Create a **Product** → verify it appears.
3. As Client, place an **Order** → verify:
   - Order created with `Processing` status.
   - Stock decremented in `inventory` (check Supabase Table Editor).
   - Ledger entry in `inventory_transactions`.
   - Order appears in Client's order history.

### 4.2 Verify Critical Production Settings

| Setting | Expected Value | Verify Via |
|---------|----------------|------------|
| `COOKIE_SECURE` | `true` | Cookie `Secure` flag in DevTools |
| `CORS_ORIGIN` | Exact Vercel URL | Network → Response Headers → `access-control-allow-origin` |
| `DATABASE_URL` | Transaction Pooler (6543) | Render logs: no `ENETUNREACH` |
| `JWT_SECRET` | ≥32 chars, random | Render env vars (masked) |
| `NODE_ENV` | `production` | Render logs: `env: production` |
| `vercel.json` rewrites | All routes → `index.html` | Refresh `/dashboard` → 200 OK |

---

## 5. Troubleshooting Common Issues

### 5.1 CORS Errors

**Symptom:**  
`Access to fetch at 'https://stockpulse-api.onrender.com/api/...' from origin 'https://stockpulse.vercel.app' has been blocked by CORS policy.`

**Causes & Fixes:**

| Cause | Fix |
|-------|-----|
| `CORS_ORIGIN` in Render doesn't match Vercel URL exactly | Update `CORS_ORIGIN` in Render env vars to `https://stockpulse.vercel.app` (no trailing slash). |
| Multiple origins needed | Use comma-separated: `https://stockpulse.vercel.app,https://staging-stockpulse.vercel.app` |
| `credentials: true` but origin is `*` | Never use `*` with credentials. Always explicit origin list. |
| Preflight `OPTIONS` fails | Ensure `helmet()` doesn't block `OPTIONS`. Current config allows it. |

**Debug:**  
In browser DevTools → Network → failed request → Headers → check `access-control-allow-origin` response header.

---

### 5.2 Authentication / Cookie Issues

**Symptom:**  
Login succeeds (200) but subsequent requests return `401 Unauthorized` or user appears logged out on refresh.

**Causes & Fixes:**

| Cause | Fix |
|-------|-----|
| `COOKIE_SECURE=false` on HTTPS | Set `COOKIE_SECURE=true` in Render env vars. |
| `CORS_ORIGIN` mismatch → cookies not sent | Fix `CORS_ORIGIN` as above. |
| Frontend `VITE_API_URL` missing `/api` | Ensure `VITE_API_URL=https://stockpulse-api.onrender.com/api` |
| Cookie `SameSite` policy | Current code uses `SameSite=Lax` (default). Works for top-level navigation. If embedded in iframe, need `SameSite=None; Secure`. |
| Clock skew (JWT expiry) | Ensure server time is synced (Render handles this). |

**Debug:**  
Check `sp_token` cookie in DevTools → Application → Cookies. Verify `Secure`, `HttpOnly`, `SameSite=Lax`, `Domain=.onrender.com` (or your custom domain).

---

### 5.3 Routing / 404 on Refresh

**Symptom:**  
Direct navigation to `/dashboard` or `/orders/123` returns 404 (Vercel 404 page).

**Fix:**  
Ensure `client/vercel.json` exists and contains:
```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```
Redeploy on Vercel after adding/fixing.

---

### 5.4 Database Connection Errors (Render Logs)

| Error | Cause | Fix |
|-------|-------|-----|
| `ENETUNREACH` | IPv6 routing to Supabase | Ensure `family: 4` in `pool.js` + using Transaction Pooler (port 6543). |
| `SELF_SIGNED_CERT_IN_CHAIN` | Supabase pooler CA not trusted | Ensure `ssl: { rejectUnauthorized: false }` in `pool.js`. |
| `ECONNREFUSED` / `ETIMEDOUT` | Wrong host/port or Supabase paused | Verify Transaction Pooler host/port. Check Supabase status. |
| `authentication failed` | Wrong password or URL-encoding | Re-check `DATABASE_URL` password encoding (§1.4). |
| `database "StockPulse" does not exist` | Wrong database name | Supabase default DB is `postgres`. Use `/postgres` in URL. |

---

### 5.5 Build / Deploy Failures

| Platform | Error | Fix |
|----------|-------|-----|
| **Render** | `npm install` fails | Check `package.json` for private deps. Ensure `package-lock.json` committed. |
| **Render** | `node src/index.js` fails | Check Node version ≥20 (`engines.node` in package.json). |
| **Render** | Migration fails | Run `npm run migrate` locally against Supabase first. Check SQL syntax. |
| **Vercel** | Build fails: `vite: not found` | Ensure `Root Directory = client` in Vercel project settings. |
| **Vercel** | `VITE_API_URL` undefined | Add `VITE_API_URL` in Vercel env vars (Production + Preview). |
| **Vercel** | 404 on refresh | Add/fix `vercel.json` rewrites (§3.1). |

---

### 5.6 WebSocket / Real-time (Future)

If adding Supabase Realtime or WebSockets:
- Render free tier **does not support WebSockets** (idle timeout kills connections).
- Use **Supabase Realtime directly from frontend** (client-side) or upgrade to Render **Standard**+ instance type.

---

## Appendix: Useful Commands

```bash
# Generate strong JWT_SECRET
openssl rand -base64 48

# URL-encode password (Node)
node -e "console.log(encodeURIComponent('your-password'))"

# Test DATABASE_URL locally
DATABASE_URL="postgres://..." npm run migrate

# View Render logs
render logs tail stockpulse-api  # via Render CLI

# View Vercel logs
vercel logs https://stockpulse.vercel.app  # via Vercel CLI
```

---

## Security Checklist (Pre-Launch)

- [ ] `JWT_SECRET` ≥ 32 chars, randomly generated, stored only in Render secrets.
- [ ] `COOKIE_SECURE=true` in production.
- [ ] `CORS_ORIGIN` restricted to exact Vercel domain(s).
- [ ] Supabase **Database Password** rotated after initial setup.
- [ ] Supabase **API Keys** (anon/service_role) not exposed in frontend.
- [ ] `BCRYPT_ROUNDS ≥ 10` in production (enforced by `env.js`).
- [ ] Rate limiting active (`express-rate-limit` on auth endpoints).
- [ ] Helmet headers active (`helmet()` in `app.js`).
- [ ] `trust proxy: 1` enabled in production (for correct `X-Forwarded-For`).
- [ ] No `.env` files committed to git (`.gitignore` includes `.env`).

---

**Guide Version:** 1.0  
**Stack:** React 18 + Vite 5 + Express 4 + pg 8 + Supabase + Render + Vercel  
**Last Verified:** Against `stockpulse` codebase at `src/` commit.

--- 

*For questions or issues, check Render/Vercel/Supabase status pages first, then review application logs.*