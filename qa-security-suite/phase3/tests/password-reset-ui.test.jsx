/**
 * Phase 3 :: Forgot password and reset password.
 *
 * The security-relevant properties of this UI are mostly about what it must NOT
 * do, so several tests assert an absence:
 *
 *   - it must not reveal whether an address has an account (one message, always);
 *   - a bad link must not render a usable form;
 *   - a successful reset must not sign the user in;
 *   - the token must not survive in the URL where Back could return to it.
 *
 * The API is stubbed at services/endpoints.js and declared with vi.hoisted in
 * this file, because a vi.mock living in a helper is registered too late to
 * intercept the page's own import.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider } from '../../../client/src/context/AuthContext.jsx';
import { ForgotPassword } from '../../../client/src/pages/ForgotPassword.jsx';
import { Login } from '../../../client/src/pages/Login.jsx';
import { ResetPassword } from '../../../client/src/pages/ResetPassword.jsx';
import { evaluatePassword } from '../../../client/src/components/PasswordStrength.jsx';

const api = vi.hoisted(() => ({
  login: vi.fn(),
  register: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
  forgotPassword: vi.fn(),
  validateResetToken: vi.fn(),
  resetPassword: vi.fn(),
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

const TOKEN = 'a'.repeat(64);
const GENERIC_MESSAGE =
  'If an account exists with this email address, you will receive a reset link shortly.';

beforeEach(() => {
  vi.clearAllMocks();
  // Anonymous visitor, exactly as the real API answers.
  api.me.mockRejectedValue(
    Object.assign(new Error('Authentication required'), { status: 401, code: 'UNAUTHENTICATED' }),
  );
});

/** Router harness with the destinations these pages navigate to. */
function renderAt(ui, route) {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<p>sign in page</p>} />
          <Route path="/forgot-password" element={<p>forgot page</p>} />
          <Route path="/reset-password" element={ui} />
          <Route path="/forgot-password-target" element={<ForgotPassword />} />
          <Route path="/dashboard" element={<p>dashboard</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('Sign In -- entry point', () => {
  it('offers a Forgot password? link to /forgot-password', async () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/forgot-password" element={<p>forgot page</p>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    const link = screen.getByRole('link', { name: /forgot password\?/i });
    expect(link).toHaveAttribute('href', '/forgot-password');
  });
});

describe('ForgotPassword', () => {
  it('renders the heading, the email field and both actions', async () => {
    renderAt(<ForgotPassword />, '/forgot-password-target');

    expect(screen.getByRole('heading', { name: 'Forgot Password?' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^email/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /back to sign in/i })).toHaveAttribute('href', '/login');
  });

  it('submits the typed address and shows the generic message verbatim', async () => {
    const user = userEvent.setup();
    api.forgotPassword.mockResolvedValue({ message: GENERIC_MESSAGE });
    renderAt(<ForgotPassword />, '/forgot-password-target');

    await user.type(screen.getByLabelText(/^email/i), 'someone@stockpulse.dev');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => expect(api.forgotPassword).toHaveBeenCalledTimes(1));
    expect(api.forgotPassword).toHaveBeenCalledWith('someone@stockpulse.dev');
    expect(await screen.findByText(GENERIC_MESSAGE)).toBeInTheDocument();
  });

  it('shows the same message for an address with no account', async () => {
    const user = userEvent.setup();
    // The server answers identically; the UI must not add a distinction of its own.
    api.forgotPassword.mockResolvedValue({ message: GENERIC_MESSAGE });
    renderAt(<ForgotPassword />, '/forgot-password-target');

    await user.type(screen.getByLabelText(/^email/i), 'nobody@nowhere.test');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText(GENERIC_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText(/no account|not found|does not exist/i)).not.toBeInTheDocument();
  });

  it('reports a throttled request without implying whether the account exists', async () => {
    const user = userEvent.setup();
    api.forgotPassword.mockRejectedValue(
      Object.assign(new Error('Too many reset requests from this address. Try again later.'), {
        status: 429,
        code: 'RATE_LIMITED',
      }),
    );
    renderAt(<ForgotPassword />, '/forgot-password-target');

    await user.type(screen.getByLabelText(/^email/i), 'someone@stockpulse.dev');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // No success state: the message must not claim a link was sent.
    expect(screen.queryByText(GENERIC_MESSAGE)).not.toBeInTheDocument();
  });
});

describe('ResetPassword -- link checking', () => {
  it('shows a verifying state while the link is checked', async () => {
    // Never settles, so the intermediate state stays observable.
    api.validateResetToken.mockReturnValue(new Promise(() => {}));
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    expect(screen.getByText(/verifying reset link/i)).toBeInTheDocument();
  });

  it('renders no form at all when the token is invalid', async () => {
    api.validateResetToken.mockResolvedValue({ valid: false });
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    expect(
      await screen.findByText('This password reset link is invalid or has expired.'),
    ).toBeInTheDocument();
    // The critical assertion: no password field to type into.
    expect(screen.queryByLabelText(/^new password/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reset password/i })).not.toBeInTheDocument();
  });

  it('treats a missing token as an invalid link', async () => {
    renderAt(<ResetPassword />, '/reset-password');

    expect(
      await screen.findByText('This password reset link is invalid or has expired.'),
    ).toBeInTheDocument();
    expect(api.validateResetToken).not.toHaveBeenCalled();
  });

  it('treats a failed check as an unusable link rather than crashing', async () => {
    api.validateResetToken.mockRejectedValue(new Error('network down'));
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    expect(
      await screen.findByText('This password reset link is invalid or has expired.'),
    ).toBeInTheDocument();
  });

  it('shows the form for a valid link and checks it without spending it', async () => {
    api.validateResetToken.mockResolvedValue({ valid: true });
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    expect(await screen.findByLabelText(/^new password/i)).toBeInTheDocument();
    expect(api.validateResetToken).toHaveBeenCalledWith(TOKEN);
    // Rendering the form must not consume the link.
    expect(api.resetPassword).not.toHaveBeenCalled();
  });

  it('asks the browser not to autofill the old password', async () => {
    api.validateResetToken.mockResolvedValue({ valid: true });
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    const first = await screen.findByLabelText(/^new password/i);
    const second = screen.getByLabelText(/^confirm new password/i);
    expect(first).toHaveAttribute('autocomplete', 'new-password');
    expect(second).toHaveAttribute('autocomplete', 'new-password');
  });
});

describe('ResetPassword -- form', () => {
  beforeEach(() => {
    api.validateResetToken.mockResolvedValue({ valid: true });
  });

  it('toggles each field independently', async () => {
    const user = userEvent.setup();
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    const first = await screen.findByLabelText(/^new password/i);
    const second = screen.getByLabelText(/^confirm new password/i);
    expect(first).toHaveAttribute('type', 'password');
    expect(second).toHaveAttribute('type', 'password');

    const [firstToggle] = screen.getAllByRole('button', { name: 'Show password' });
    await user.click(firstToggle);

    expect(first).toHaveAttribute('type', 'text');
    expect(second).toHaveAttribute('type', 'password');
    // Revealing one must not alter what was typed anywhere.
    await user.type(first, 'Sup3rSecretPass!');
    expect(first).toHaveValue('Sup3rSecretPass!');
  });

  it('shows a strength meter and the requirements checklist', async () => {
    const user = userEvent.setup();
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    const field = await screen.findByLabelText(/^new password/i);
    expect(screen.getByTestId('password-strength')).toBeInTheDocument();
    expect(screen.getByText('At least 12 characters')).toBeInTheDocument();

    await user.type(field, 'Short1!');
    // Advisory only: a weak password must not disable the submit button.
    expect(screen.getByRole('button', { name: /reset password/i })).toBeEnabled();
  });

  it('blocks a password below the server policy length', async () => {
    const user = userEvent.setup();
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    await user.type(await screen.findByLabelText(/^new password/i), 'Short1234');
    await user.type(screen.getByLabelText(/^confirm new password/i), 'Short1234');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    // Matched on the field error specifically: the strength checklist also
    // contains the words "At least 12 characters", so a looser pattern finds
    // two elements and findByText throws.
    expect(await screen.findByText('Password must be at least 12 characters')).toBeInTheDocument();
    expect(api.resetPassword).not.toHaveBeenCalled();
  });

  it('blocks a mismatched confirmation', async () => {
    const user = userEvent.setup();
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    await user.type(await screen.findByLabelText(/^new password/i), 'ValidPassword123!');
    await user.type(screen.getByLabelText(/^confirm new password/i), 'DifferentPassword123!');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(api.resetPassword).not.toHaveBeenCalled();
  });

  it('submits the token and both passwords, then reports success without signing in', async () => {
    const user = userEvent.setup();
    api.resetPassword.mockResolvedValue({ message: 'ok', data: { id: 1 } });
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    await user.type(await screen.findByLabelText(/^new password/i), 'ValidPassword123!');
    await user.type(screen.getByLabelText(/^confirm new password/i), 'ValidPassword123!');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => expect(api.resetPassword).toHaveBeenCalledTimes(1));
    expect(api.resetPassword).toHaveBeenCalledWith({
      token: TOKEN,
      password: 'ValidPassword123!',
      confirmPassword: 'ValidPassword123!',
    });

    expect(await screen.findByText('Password Reset Successfully!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in now/i })).toBeInTheDocument();

    // No session was created: the sign-in endpoint was never called, and the
    // success screen must still be showing (not flipped to "invalid" just
    // because the token was stripped from the URL).
    expect(api.login).not.toHaveBeenCalled();
    expect(
      screen.queryByText('This password reset link is invalid or has expired.'),
    ).not.toBeInTheDocument();
  });

  it('sends the user to sign in from the success screen', async () => {
    const user = userEvent.setup();
    api.resetPassword.mockResolvedValue({ message: 'ok', data: { id: 1 } });
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    await user.type(await screen.findByLabelText(/^new password/i), 'ValidPassword123!');
    await user.type(screen.getByLabelText(/^confirm new password/i), 'ValidPassword123!');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    await user.click(await screen.findByRole('button', { name: /sign in now/i }));

    expect(await screen.findByText('sign in page')).toBeInTheDocument();
  });

  it('falls back to the invalid state when the token is spent mid-flight', async () => {
    const user = userEvent.setup();
    api.resetPassword.mockRejectedValue(
      Object.assign(new Error('This password reset link is invalid or has expired'), {
        status: 400,
        code: 'INVALID_RESET_TOKEN',
      }),
    );
    renderAt(<ResetPassword />, `/reset-password?token=${TOKEN}`);

    await user.type(await screen.findByLabelText(/^new password/i), 'ValidPassword123!');
    await user.type(screen.getByLabelText(/^confirm new password/i), 'ValidPassword123!');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(
      await screen.findByText('This password reset link is invalid or has expired.'),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^new password/i)).not.toBeInTheDocument();
  });
});

describe('evaluatePassword', () => {
  it('treats length as the only hard requirement signal', () => {
    // 12+ with no variety still scores on length.
    expect(evaluatePassword('aaaaaaaaaaaa').checks.find((check) => check.id === 'length').met).toBe(true);
    expect(evaluatePassword('aaaaaaaaaaa').checks.find((check) => check.id === 'length').met).toBe(false);
  });

  it('reports each guideline independently', () => {
    const { checks, score } = evaluatePassword('Abcdefgh1234!');
    expect(checks.every((check) => check.met)).toBe(true);
    expect(score).toBe(4);
  });

  it('does not require variety for a long passphrase', () => {
    // Length alone lifts the verdict; the checklist stays advisory.
    expect(evaluatePassword('correcthorsebatterystaple').label).toBe('Strong');
  });
});
