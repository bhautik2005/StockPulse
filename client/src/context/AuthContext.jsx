import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { INTERNAL_ROLES } from '../lib/constants.js';
import { setUnauthorizedHandler } from '../services/api.js';
import { authApi } from '../services/endpoints.js';

const AuthContext = createContext(null);

/**
 * Global authentication state.
 *
 * Two decisions worth stating:
 *
 *  - Nothing about the session is stored in the browser. The JWT lives in an
 *    HttpOnly cookie that JavaScript cannot read; on reload the app re-asks
 *    `GET /api/auth/me` and is told who it is. The alternative -- caching the
 *    user (or the token) in localStorage -- reintroduces exactly the risk the
 *    HttpOnly cookie removes.
 *
 *  - After a successful login we call `/me` rather than trusting the login
 *    response. The server is then the single source of the user's role and
 *    warehouse scope, and the same code path runs on reload and on sign-in.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('loading');
  const [bootError, setBootError] = useState(null);

  const hydrate = useCallback(async () => {
    try {
      const { data } = await authApi.me();
      setUser(data);
      setStatus('authenticated');
      setBootError(null);
    } catch (error) {
      setUser(null);
      setStatus('anonymous');
      // A 401 here is the normal "nobody is signed in" answer, not a failure
      // worth showing. Anything else (the API being down) is worth showing.
      if (error.status !== 401) setBootError(error);
    }
  }, []);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    // A session revoked or expired mid-flight (an admin changed the role, the
    // token was invalidated) drops the user to the sign-in screen on the next
    // request, instead of leaving a half-broken page behind.
    setUnauthorizedHandler(() => {
      setUser(null);
      setStatus('anonymous');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const login = useCallback(
    async (credentials) => {
      await authApi.login(credentials);
      const { data } = await authApi.me();
      setUser(data);
      setStatus('authenticated');
      return data;
    },
    [],
  );

  const register = useCallback(
    async (details) => {
      await authApi.register(details);
      return login({ email: details.email, password: details.password });
    },
    [login],
  );

  const logout = useCallback(async ({ all = false } = {}) => {
    try {
      await authApi.logout(all);
    } finally {
      // Even if the request fails, the local session is over.
      setUser(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo(() => {
    const scope = user?.scope ?? { all: false, ids: [] };
    const isInternal = INTERNAL_ROLES.includes(user?.role);

    return {
      user,
      status,
      bootError,
      isAuthenticated: status === 'authenticated',
      isLoading: status === 'loading',
      isInternal,
      isClient: user?.role === 'Client',
      isAdmin: user?.role === 'Admin',
      /** True when the caller may see every warehouse (Admin). */
      hasGlobalScope: Boolean(scope.all),
      /** Warehouse ids the caller is responsible for. */
      scopeIds: scope.ids ?? [],
      login,
      logout,
      register,
      refresh: hydrate,
      /** Role check for conditional UI; the server enforces the real rule. */
      can: (...roles) => Boolean(user && roles.includes(user.role)),
    };
  }, [user, status, bootError, login, logout, register, hydrate]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}