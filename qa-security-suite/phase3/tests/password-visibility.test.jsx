/**
 * Phase 3 :: Sign In -- password visibility.
 *
 * The requirement is small but has four independent failure modes, so each one
 * gets its own assertion:
 *
 *   1. the field is masked until asked otherwise, and unmasked after;
 *   2. the icon reflects the state (EyeOff while hidden, Eye while shown);
 *   3. toggling must NOT clear or alter what the user typed -- the classic
 *      regression here is remounting the input and losing the value;
 *   4. the control must not submit the form, and a normal sign-in must still
 *      reach the API with exactly the typed credentials.
 *
 * Point 4 is the "login still works" guard: it exercises the real AuthContext
 * and the real Login component, stubbing only the network layer.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../../client/src/context/AuthContext.jsx';
import { Login } from '../../../client/src/pages/Login.jsx';

/*
 * Declared with `vi.hoisted` and mocked HERE, in the test file.
 *
 * A `vi.mock` that lives in a helper module is registered too late: the page
 * component -- and therefore its transitive `services/endpoints.js` import -- is
 * evaluated first, so the real fetch runs and every test sees a network error.
 * Keeping the mock in the file under test lets Vitest hoist it above the
 * imports, which is what makes the stub actually take effect.
 */
const api = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../../../client/src/services/endpoints.js', () => ({
  authApi: api,
  productsApi: {},
  ordersApi: {},
  warehousesApi: {},
  inventoryApi: {},
  analyticsApi: {},
  usersApi: {},
  catalogApi: {},
}));

const CREDENTIALS = { email: 'admin@stockpulse.dev', password: 'AdminPass1234' };

function renderLogin(route = '/login') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>
        <Routes>
          {/* Signing in navigates to /dashboard; a distinct target keeps that
              observable without re-rendering Login and looping the redirect. */}
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<p>signed in</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

/** The password control itself, matched by its own label ("Password*"). */
const passwordInput = () => screen.getByLabelText(/^password/i);

/** Lucide tags its SVG with `lucide-<name>`, which makes the icon assertable. */
const iconOf = (button) => button.querySelector('svg')?.getAttribute('class') ?? '';

describe('Phase 3 :: Sign In -- password visibility', () => {
  beforeEach(() => {
    api.login.mockReset();
    api.me.mockReset();
    api.logout.mockReset();
    // Anonymous visitor: the real server answers 401 for /me, and that is what
    // lets the sign-in form render instead of a redirect.
    api.me.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401, code: 'UNAUTHENTICATED' }),
    );
  });

  it('defaults to hidden, showing an EyeOff control labelled "Show password"', async () => {
    renderLogin();

    const input = await screen.findByLabelText(/^password/i);
    expect(input).toHaveAttribute('type', 'password');

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(iconOf(toggle)).toContain('lucide-eye-off');
    // A submit-by-accident would sign the user in when they only wanted to peek.
    expect(toggle).toHaveAttribute('type', 'button');
  });

  it('reveals the password and swaps the icon to Eye when clicked', async () => {
    const user = userEvent.setup();
    renderLogin();

    const input = await screen.findByLabelText(/^password/i);
    await user.click(screen.getByRole('button', { name: 'Show password' }));

    expect(input).toHaveAttribute('type', 'text');

    const toggle = screen.getByRole('button', { name: 'Hide password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(iconOf(toggle)).toContain('lucide-eye');
  });

  it('hides the password again and restores EyeOff on the second click', async () => {
    const user = userEvent.setup();
    renderLogin();

    const input = await screen.findByLabelText(/^password/i);
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveAttribute('type', 'text');

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveAttribute('type', 'password');

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(iconOf(toggle)).toContain('lucide-eye-off');
  });

  it('never clears or modifies the entered value while toggling', async () => {
    const user = userEvent.setup();
    renderLogin();

    const input = await screen.findByLabelText(/^password/i);
    await user.type(input, CREDENTIALS.password);
    expect(input).toHaveValue(CREDENTIALS.password);

    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(input).toHaveValue(CREDENTIALS.password);

    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(input).toHaveValue(CREDENTIALS.password);

    // The DOM node is reused rather than remounted, which is what preserves the
    // value across the type change.
    expect(passwordInput()).toBe(input);
  });

  it('does not submit the form when the eye icon is clicked', async () => {
    const user = userEvent.setup();
    renderLogin();

    await screen.findByLabelText(/^password/i);
    await user.click(screen.getByRole('button', { name: 'Show password' }));

    expect(api.login).not.toHaveBeenCalled();
  });

  it('still signs in normally, sending the typed credentials once', async () => {
    const user = userEvent.setup();
    api.login.mockResolvedValue({ data: { id: 1, name: 'Ada', role: 'Admin' }, meta: {} });

    renderLogin();

    await user.type(await screen.findByLabelText(/email/i), CREDENTIALS.email);
    await user.type(passwordInput(), CREDENTIALS.password);

    // Only now does the post-login `/me` hydration succeed; resolving it before
    // the render would boot the app as already signed in and hide the form.
    api.me.mockResolvedValue({ data: { id: 1, name: 'Ada', role: 'Admin', scope: { all: true, ids: null } } });
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(api.login).toHaveBeenCalledTimes(1);
      expect(api.login).toHaveBeenCalledWith(CREDENTIALS);
    });
  });

  it('signs in correctly after the password has been revealed', async () => {
    const user = userEvent.setup();
    api.login.mockResolvedValue({ data: { id: 1, name: 'Ada', role: 'Admin' }, meta: {} });

    renderLogin();

    await user.type(await screen.findByLabelText(/email/i), CREDENTIALS.email);
    await user.type(passwordInput(), CREDENTIALS.password);

    // Reveal first, then submit while visible: the payload must be identical.
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    api.me.mockResolvedValue({ data: { id: 1, name: 'Ada', role: 'Admin', scope: { all: true, ids: null } } });
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(api.login).toHaveBeenCalledWith(CREDENTIALS));
  });

  it('reports a rejected sign-in and stays usable', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../../../client/src/services/api.js');
    api.login.mockRejectedValue(
      new ApiError(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }),
    );

    renderLogin();

    await user.type(await screen.findByLabelText(/email/i), CREDENTIALS.email);
    await user.type(passwordInput(), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/email or password is incorrect/i);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
    // The visibility control survives the failure and still works.
    expect(screen.getByRole('button', { name: 'Show password' })).toBeInTheDocument();
  });
});
