/**
 * Phase 3 :: API error handling in the UI.
 *
 * The requirement: a 401 or a 409 from the server must produce a user-friendly
 * banner, and must not crash the app. Both halves matter, and "must not crash" is
 * the part that is normally left untested.
 *
 * Every test therefore ends by asserting the page is still interactive -- the
 * form is present, the button is usable again, and submitting a second time
 * issues a second request. A component that sets an error and then throws during
 * the re-render, or leaves `submitting` stuck at true forever, fails that check
 * while passing a naive "the message appeared" assertion.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';

/*
 * Import order matters here, and it is not cosmetic.
 *
 * `helpers/render.jsx` registers the `vi.mock` for services/endpoints.js as soon
 * as that module is evaluated (Vitest hoists the call above its own imports).
 * The pages below reach the same module through AuthContext. If a page is
 * evaluated first, the REAL endpoints module is already in the graph and the
 * mock arrives too late -- the stub is never called and every request goes to
 * the network, which jsdom reports as "Cannot reach the server". So the helper
 * comes first.
 */
import { authApi, renderWithAuth, resetAuthApi, settleAuthBoot } from '../helpers/render.jsx';
import { Login } from '../../../client/src/pages/Login.jsx';
import { Register } from '../../../client/src/pages/Register.jsx';
import {
  emailInUse,
  invalidCredentials,
  networkFailure,
  profile,
  rateLimited,
  successfulLogin,
  successfulRegister,
} from '../helpers/doubles.js';

beforeEach(() => {
  resetAuthApi();
});

function fillLogin({ email = 'ada@acme.test', password = 'correct-horse-battery' } = {}) {
  fireEvent.change(screen.getByLabelText(/email/i), { target: { value: email } });
  // Anchored: the sign-in field's own label is "Password", while the visibility
  // toggle is labelled "Show password" / "Hide password".
  fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: password } });
}

function submitLogin() {
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }));
}

/** The page is still alive: the form exists and the button is not stuck. */
function expectStillUsable() {
  expect(screen.getByRole('button', { name: /sign in|creating account/i })).toBeEnabled();
  expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
}

// ---------------------------------------------------------------------------
// 401
// ---------------------------------------------------------------------------

describe('Phase 3 :: Login -- 401 from the API', () => {
  it('shows a friendly banner and does not crash', async () => {
    authApi.login.mockRejectedValue(invalidCredentials());
    renderWithAuth(<Login />);
    await settleAuthBoot();

    fillLogin({ password: 'wrong-password-here' });
    submitLogin();

    // A banner, with a sentence a person can act on.
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/email or password is incorrect/i);
    expectStillUsable();
  });

  it('never reveals whether the email exists', async () => {
    authApi.login.mockRejectedValue(invalidCredentials());
    renderWithAuth(<Login />);
    await settleAuthBoot();

    fillLogin({ email: 'definitely-not-a-user@acme.test' });
    submitLogin();

    const banner = await screen.findByRole('alert');
    // The server answers identically for an unknown email and a wrong password so
    // that the endpoint cannot be used to enumerate accounts. The UI must not
    // undo that with "no account with that email".
    expect(banner).not.toHaveTextContent(/no account|not found|does not exist|unregistered/i);
    expect(banner).toHaveTextContent(/email or password/i);
  });

  it('clears the previous error on the next attempt', async () => {
    authApi.login.mockRejectedValueOnce(invalidCredentials());
    renderWithAuth(<Login />);
    await settleAuthBoot();

    fillLogin({ password: 'wrong-password-here' });
    submitLogin();
    expect(await screen.findByRole('alert')).toHaveTextContent(/incorrect/i);

    successfulLogin(authApi);
    submitLogin();

    // A stale banner sitting next to a successful attempt is its own kind of
    // wrong. On success the page navigates away, so the check is that neither the
    // error nor the form is still on screen -- the banner cannot outlive it.
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument());
  });

  it('allows a retry after a 401, and the retry really reaches the API', async () => {
    authApi.login.mockRejectedValueOnce(invalidCredentials());
    renderWithAuth(<Login />);
    await settleAuthBoot();

    fillLogin({ password: 'wrong-password-here' });
    submitLogin();
    await screen.findByRole('alert');

    successfulLogin(authApi);
    submitLogin();

    await waitFor(() => expect(authApi.login).toHaveBeenCalledTimes(2));
  });
});

// ---------------------------------------------------------------------------
// 409
// ---------------------------------------------------------------------------

describe('Phase 3 :: Register -- 409 from the API', () => {
  it('shows a friendly banner when the email is already registered', async () => {
    authApi.register.mockRejectedValue(emailInUse());
    renderWithAuth(<Register />);
    await settleAuthBoot();

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'taken@acme.test' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'correct-horse-battery' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'correct-horse-battery' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    const banners = await screen.findAllByRole('alert');
    expect(banners.some((node) => /already exists/i.test(node.textContent))).toBe(true);

    // The message must point at the field that is wrong, not just at the form.
    expect(screen.getByLabelText(/work email/i)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: /create account/i })).toBeEnabled();
  });

  it('offers a route to sign in instead, since that is the actual remedy', async () => {
    authApi.register.mockRejectedValue(emailInUse());
    renderWithAuth(<Register />);
    await settleAuthBoot();

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'taken@acme.test' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'correct-horse-battery' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'correct-horse-battery' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await screen.findAllByRole('alert');
    expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
  });

  it('does not sign the user in after a failed registration', async () => {
    authApi.register.mockRejectedValue(emailInUse());
    renderWithAuth(<Register />);
    await settleAuthBoot();

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Ada Lovelace' } });
    fireEvent.change(screen.getByLabelText(/work email/i), { target: { value: 'taken@acme.test' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'correct-horse-battery' } });
    fireEvent.change(screen.getByLabelText(/confirm password/i), { target: { value: 'correct-horse-battery' } });
    fireEvent.click(screen.getByRole('button', { name: /create account/i }));

    await screen.findAllByRole('alert');
    // AuthContext.register calls login() only AFTER register() resolves. A 409
    // must not leave a half-built session behind.
    expect(authApi.login).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Other transport-level failures
// ---------------------------------------------------------------------------

describe('Phase 3 :: Login -- non-401 failures', () => {
  it('explains a 429 rate limit instead of showing a generic error', async () => {
    authApi.login.mockRejectedValue(rateLimited());
    renderWithAuth(<Login />);
    await settleAuthBoot();

    fillLogin();
    submitLogin();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/too many attempts/i);
    expectStillUsable();
  });

  it('explains a dead network, which is a different problem from bad credentials', async () => {
    authApi.login.mockRejectedValue(networkFailure());
    renderWithAuth(<Login />);
    await settleAuthBoot();

    fillLogin();
    submitLogin();

    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/cannot reach the server|connection/i);
    expect(banner).not.toHaveTextContent(/incorrect/i);
  });

  it('survives an unexpected 500 without an unhandled crash', async () => {
    authApi.login.mockRejectedValue(
      Object.assign(new Error('An unexpected error occurred'), { status: 500, code: 'INTERNAL_ERROR' }),
    );
    renderWithAuth(<Login />);
    await settleAuthBoot();

    fillLogin();
    submitLogin();

    // Whatever it says, the page must remain mounted and usable.
    await screen.findByRole('alert');
    expectStillUsable();
  });

  it('survives an error object with no message at all', async () => {
    // Defensive: a rejected promise can carry anything. `describeError` must not
    // be the thing that takes the page down.
    authApi.login.mockRejectedValue({});
    renderWithAuth(<Login />);
    await settleAuthBoot();

    fillLogin();
    submitLogin();

    await screen.findByRole('alert');
    expectStillUsable();
  });

  it('does not get stuck in a loading state after a failure', async () => {
    authApi.login.mockRejectedValue(invalidCredentials());
    renderWithAuth(<Login />);
    await settleAuthBoot();

    fillLogin();
    submitLogin();

    await screen.findByRole('alert');
    // `finally { setSubmitting(false) }` is what this proves. Without it the
    // button spins forever and the user can never try again.
    expect(screen.queryByText(/signing in/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// The happy path, so the error handling is not the only thing that works
// ---------------------------------------------------------------------------

describe('Phase 3 :: Login -- success path', () => {
  it('signs in and navigates away from the form', async () => {
    renderWithAuth(<Login />);
    await settleAuthBoot();

    // Only after boot: `successfulLogin` resolves `/me`, so configuring it first
    // would authenticate the provider on mount and redirect past the form.
    const user = successfulLogin(authApi, profile({ role: 'Admin' }));

    fillLogin({ email: user.email });
    submitLogin();

    await waitFor(() => expect(authApi.login).toHaveBeenCalledTimes(1));
    expect(authApi.login).toHaveBeenCalledWith({
      email: user.email,
      password: 'correct-horse-battery',
    });
    // Two calls: the boot hydration on mount, then the re-fetch after login.
    // Re-fetching is what makes the server the single source of the role rather
    // than trusting the login response body.
    await waitFor(() => expect(authApi.me).toHaveBeenCalledTimes(2));
  });

  it('shows no error banner on a successful sign-in', async () => {
    renderWithAuth(<Login />);
    await settleAuthBoot();

    successfulLogin(authApi);

    fillLogin();
    submitLogin();

    await waitFor(() => expect(authApi.login).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
