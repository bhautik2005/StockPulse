/**
 * Phase 3 :: render helper.
 *
 * The pages under test are not standalone functions -- they read auth state from
 * AuthContext and navigate through React Router. Rendering them bare would test
 * a component that never exists in the real app, so every render goes through the
 * same provider stack `main.jsx` uses.
 *
 * The API is stubbed at `services/endpoints.js`, one layer below AuthContext.
 * That is deliberate: it exercises the real context (hydration, the post-login
 * `/me` call, the 401 handler) while removing only the network. Stubbing
 * `useAuth` instead would skip the code most likely to be wrong.
 */
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';

import { AuthProvider } from '../../../client/src/context/AuthContext.jsx';
import { createAuthApiStub } from './doubles.js';

/**
 * INSTALLS the API stub for the current test file.
 *
 * Must be called at module scope, next to the imports -- `vi.mock` is hoisted
 * above them, and the factory below closes over `authApi`, so the object has to
 * exist before the first render. Returns the stub so a test can assert on calls.
 */
export const authApi = createAuthApiStub();

vi.mock('../../../client/src/services/endpoints.js', () => ({
  authApi: {
    login: (...args) => authApi.login(...args),
    register: (...args) => authApi.register(...args),
    me: (...args) => authApi.me(...args),
    logout: (...args) => authApi.logout(...args),
  },
  // Other modules import these from the same barrel; keep them inert so a stray
  // import does not explode at collection time.
  productsApi: new Proxy({}, { get: () => vi.fn() }),
  ordersApi: new Proxy({}, { get: () => vi.fn() }),
  warehousesApi: new Proxy({}, { get: () => vi.fn() }),
  inventoryApi: new Proxy({}, { get: () => vi.fn() }),
  analyticsApi: new Proxy({}, { get: () => vi.fn() }),
  usersApi: new Proxy({}, { get: () => vi.fn() }),
}));

/** Resets the stub between tests; call from a global beforeEach if desired. */
export function resetAuthApi(overrides = {}) {
  authApi.login.mockReset();
  authApi.register.mockReset();
  authApi.me.mockReset();
  authApi.logout.mockReset();
  // Default: nobody is signed in. This is the real server's answer for an
  // anonymous visitor, not a convenience.
  authApi.me.mockRejectedValue(
    Object.assign(new Error('Authentication required'), { status: 401, code: 'UNAUTHENTICATED' }),
  );
  Object.assign(authApi, overrides);
  return authApi;
}

/**
 * Renders `ui` inside AuthProvider + MemoryRouter.
 *
 * A catch-all route renders the current pathname, so a redirect is observable
 * without spying on the router internals: after a successful sign-in the probe
 * shows where the user would land.
 */
export function renderWithAuth(ui, { route = '/' } = {}) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>
        <Routes>
          <Route path="*" element={ui} />
          <Route
            path="/__location"
            element={<LocationProbe />}
          />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** Reports the path the router is currently showing. */
export function LocationProbe() {
  return <output data-testid="location">{window.location.pathname}</output>;
}

/**
 * Waits for AuthProvider's boot `/me` call to settle.
 *
 * Until it does, `status` is 'loading' and both pages render normally, but an
 * assertion made too early can race the state update and flake. Awaiting a
 * stable, non-loading signal first is what makes the rest deterministic.
 */
export async function settleAuthBoot() {
  // The provider resolves to 'anonymous' after the 401. A microtask flush plus a
  // timer tick covers both the promise and the React commit.
  await new Promise((resolve) => setTimeout(resolve, 0));
}
