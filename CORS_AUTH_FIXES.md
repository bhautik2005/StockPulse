# StockPulse CORS & Authentication Fixes

## Root Cause Analysis

The intermittent CORS errors and authentication failures stem from **environment variable mismatches** between development and production:

| Issue | Cause | Impact |
|-------|-------|--------|
| CORS errors on some requests | `CORS_ORIGIN` on Render doesn't match Vercel URL exactly | Preflight OPTIONS requests fail, cookies not sent |
| 401 on `/api/auth/me` after login | Cookies blocked due to CORS mismatch + `COOKIE_SECURE=false` on HTTPS | Session cookie not sent with subsequent requests |
| 409 on `/api/auth/register` | User already exists (expected behavior) | Needs graceful UI handling |

---

## Required Configuration Changes

### 1. Render Dashboard → Environment Variables

Update these in your Render service settings:

```bash
# Exact Vercel URL - NO trailing slash, NO /api
CORS_ORIGIN=https://stock-pulse-theta-henna.vercel.app

# Required for HTTPS (Vercel + Render both use HTTPS)
COOKIE_SECURE=true

# Production mode enables trust proxy and other security features
NODE_ENV=production
```

### 2. Vercel Dashboard → Settings → Environment Variables

```bash
# Exact Render URL - NO trailing slash, NO /api
VITE_API_URL=https://stockpulse-pgnq.onrender.com
```

### 3. Verify the Configuration

After updating, redeploy both services and verify:

```bash
# 1. Backend health
curl https://stockpulse-pgnq.onrender.com/health

# 2. Check CORS headers
curl -H "Origin: https://stock-pulse-theta-henna.vercel.app" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: Content-Type" \
     -X OPTIONS \
     https://stockpulse-pgnq.onrender.com/api/auth/login \
     -v

# Expected response headers:
# access-control-allow-origin: https://stock-pulse-theta-henna.vercel.app
# access-control-allow-credentials: true
# access-control-allow-methods: GET,POST,PATCH,DELETE,OPTIONS
# access-control-allow-headers: Content-Type,Authorization,X-CSRF-Token,Idempotency-Key,X-Requested-With
```

---

## Code Changes Made

### Backend: `src/app.js` - Enhanced CORS Configuration

Added explicit preflight handling:
```javascript
app.use(cors({
  origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'Idempotency-Key', 'X-Requested-With'],
  exposedHeaders: ['X-Request-Id'],
  maxAge: 86400, // Cache preflight for 24 hours
}));
```

### Frontend: `client/src/lib/errors.js` - Improved Error Handling

Added helper functions for better error categorization:
- `isNetworkError(error)` - Detects connectivity issues
- `isAuthError(error)` - Detects expired/revoked sessions
- `isConflictError(error)` - Detects 409 conflicts
- Enhanced `describeError()` with specific 409 handling

### Frontend: `client/src/pages/Register.jsx` - Graceful 409 Handling

```javascript
} catch (caught) {
  if (isConflictError(caught)) {
    setError(caught);
    setErrors({ email: describeError(caught) }); // Show inline field error
  } else {
    setError(caught);
  }
}
```

### Frontend: `client/src/pages/Login.jsx` - Better Network Error Messages

```javascript
} catch (caught) {
  if (isNetworkError(caught)) {
    setError({ ...caught, message: 'Cannot reach the server. Please check your connection or try again later.' });
  } else {
    setError(caught);
  }
}
```

---

## How CORS + Cookies Work in This Stack

```
┌─────────────────┐     HTTPS      ┌──────────────────┐
│  Vercel Frontend │ ─────────────► │  Render Backend  │
│  (React/Vite)    │  credentials:  │  (Express/Node)  │
│                  │    'include'   │                  │
└─────────────────┘                └──────────────────┘
        │                                    │
        │ 1. Login POST /api/auth/login      │
        │    ─────────────────────────────►  │
        │                                    │
        │ 2. Response: 200 OK               │
        │    Set-Cookie: sp_token=...;       │
        │    HttpOnly; Secure; SameSite=Lax  │
        │    Set-Cookie: sp_csrf=...;        │
        │    (readable for CSRF)             │
        │    ◄─────────────────────────────  │
        │                                    │
        │ 3. GET /api/auth/me (with cookie)  │
        │    ─────────────────────────────►  │
        │    (Cookie automatically included  │
        │     because credentials: 'include')│
        │                                    │
        │ 4. Response: 200 OK + user data    │
        │    ◄─────────────────────────────  │
```

**Critical Requirements:**
1. `CORS_ORIGIN` must exactly match the frontend origin (protocol + domain + port)
2. `COOKIE_SECURE=true` for HTTPS (required for `Secure` cookie flag)
3. `credentials: 'include'` on all frontend fetch requests
4. Backend sets `Access-Control-Allow-Credentials: true`

---

## Debugging Checklist

If issues persist after configuration:

### Check Render Logs
```bash
# Look for:
# - "CORS_ORIGIN" value at startup
# - Request logs showing Origin header
# - Cookie parsing in authenticate middleware
```

### Check Browser DevTools
1. **Network Tab** → Failed request → Headers
   - Request: `Origin: https://stock-pulse-theta-henna.vercel.app`
   - Response: `access-control-allow-origin: https://stock-pulse-theta-henna.vercel.app`
   - Response: `access-control-allow-credentials: true`

2. **Application Tab** → Cookies
   - `sp_token`: HttpOnly ✓, Secure ✓, SameSite=Lax
   - `sp_csrf`: HttpOnly ✗ (readable), Secure ✓, SameSite=Lax

3. **Console**
   - Look for CORS error messages
   - Network failures (status 0) = connectivity issue

### Common Mistakes
| Mistake | Fix |
|---------|-----|
| `CORS_ORIGIN=https://stock-pulse-theta-henna.vercel.app/` (trailing slash) | Remove trailing slash |
| `CORS_ORIGIN=*` with `credentials: true` | Never use `*` with credentials |
| `VITE_API_URL=https://stockpulse-pgnq.onrender.com/api` | Remove `/api` |
| `COOKIE_SECURE=false` on production | Set to `true` |
| Multiple origins without comma separation | Use `origin1,origin2` format |

---

## Verification Steps After Fix

1. **Deploy backend** with new env vars → check Render logs for `env: production`
2. **Deploy frontend** with new `VITE_API_URL` → check Vercel build logs
3. **Test login flow**:
   - Open https://stock-pulse-theta-henna.vercel.app
   - Sign in with demo credentials
   - Verify redirect to dashboard
   - Check Network tab: all requests to `https://stockpulse-pgnq.onrender.com/api/...` return 200
4. **Test refresh**: Refresh dashboard page → should stay logged in (calls `/api/auth/me`)
5. **Test register**: Try registering existing email → should show "already exists" message

---

## Files Modified

- `src/app.js` - Enhanced CORS configuration with explicit preflight handling
- `client/src/lib/errors.js` - Added error classification helpers
- `client/src/pages/Login.jsx` - Better network error messaging
- `client/src/pages/Register.jsx` - Graceful 409 conflict handling with inline field error

---

## Next Steps

1. ✅ Update Render environment variables
2. ✅ Update Vercel environment variables
3. ✅ Redeploy both services
4. ✅ Verify with the debugging checklist above
5. Monitor for any remaining issues in Render/Vercel logs