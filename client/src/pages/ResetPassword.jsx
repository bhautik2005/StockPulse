import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Boxes, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';

import { authApi } from '../services/endpoints.js';
import { describeError, isNetworkError } from '../lib/errors.js';
import { Alert } from '../components/ui/Feedback.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Field } from '../components/ui/Input.jsx';
import { PasswordInput } from '../components/ui/PasswordInput.jsx';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PasswordStrength } from '../components/PasswordStrength.jsx';

/** Wording is fixed by the product spec; the server says the same thing. */
const INVALID_LINK_MESSAGE = 'This password reset link is invalid or has expired.';

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [status, setStatus] = useState('verifying');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState(null);

  /*
   * Set once the link is spent. The token is then stripped from the address bar
   * (see the success path below), which re-runs the effect with `token === null`;
   * without this flag that would flip the page back to "invalid" right after a
   * successful reset.
   */
  const finished = useRef(false);

  /*
   * Check the link before showing a form.
   *
   * This is a read-only check -- it does not spend the token -- so a user who
   * reloads the page, or whose browser prefetches it, still finds a working
   * form. The token is only consumed by the POST that actually sets a password.
   */
  useEffect(() => {
    if (finished.current) return;

    if (!token) {
      setStatus('invalid');
      return;
    }

    let cancelled = false;
    setStatus('verifying');

    authApi
      .validateResetToken(token)
      .then((result) => {
        if (!cancelled) setStatus(result?.valid ? 'ready' : 'invalid');
      })
      .catch(() => {
        // A failed check (offline, 429) is reported as an unusable link rather
        // than as a form that will certainly fail on submit.
        if (!cancelled) setStatus('invalid');
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);

    // Mirror the server's rules exactly: length is required, the checklist is
    // not. Validating here only saves a round trip -- the API checks again.
    const nextErrors = {};
    if (password.length < PASSWORD_MIN_LENGTH) {
      nextErrors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
    } else if (password.length > PASSWORD_MAX_LENGTH) {
      nextErrors.password = `Password must be at most ${PASSWORD_MAX_LENGTH} characters (bcrypt limit)`;
    }
    if (password !== confirmPassword) {
      nextErrors.confirmPassword = 'Passwords do not match';
    }

    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    setStatus('submitting');
    try {
      await authApi.resetPassword({ token, password, confirmPassword });

      // The link is spent. Replace the history entry so the token is no longer
      // in the URL -- pressing Back must not land on a form holding a token
      // that has already been used.
      finished.current = true;
      setPassword('');
      setConfirmPassword('');
      setStatus('success');
      navigate('/reset-password', { replace: true });
    } catch (caught) {
      if (caught?.code === 'INVALID_RESET_TOKEN') {
        // Expired or spent between the check and the submit (or lost a race
        // against another tab). Show the honest state, not a retryable error.
        finished.current = true;
        setStatus('invalid');
        navigate('/reset-password', { replace: true });
        return;
      }
      setStatus('ready');
      setError(
        isNetworkError(caught)
          ? { ...caught, message: 'Cannot reach the server. Please check your connection or try again later.' }
          : caught,
      );
    }
  }

  // ---- Verifying -----------------------------------------------------------
  if (status === 'verifying') {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground" role="status">
          Verifying reset link...
        </p>
      </div>
    );
  }

  // ---- Invalid or expired --------------------------------------------------
  if (status === 'invalid') {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold tracking-tight">Reset link problem</h1>
        </div>

        <Alert tone="destructive" title="This link cannot be used">
          {INVALID_LINK_MESSAGE}
        </Alert>

        <div className="flex flex-col gap-2">
          <Button type="button" className="w-full" onClick={() => navigate('/forgot-password')}>
            Request a new link
          </Button>
          <Link
            to="/login"
            className="focus-ring rounded text-center text-xs font-medium text-primary hover:underline"
          >
            Back to Sign In
          </Link>
        </div>
      </div>
    );
  }

  // ---- Success -------------------------------------------------------------
  if (status === 'success') {
    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="rounded-full border border-success/40 bg-success/10 p-3">
            <CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />
          </div>
          <h1 className="text-lg font-semibold tracking-tight">Password Reset Successfully!</h1>
          <p className="text-xs text-muted-foreground">
            Your password has been changed and any other active sessions were signed out.
          </p>
        </div>

        {/* No auto-login on purpose: the reset link proves control of a mailbox,
            not knowledge of the new password, and the API issues no session. */}
        <Button type="button" className="w-full" onClick={() => navigate('/login', { replace: true })}>
          Sign In Now
        </Button>
      </div>
    );
  }

  // ---- Ready / submitting --------------------------------------------------
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 lg:hidden">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Boxes className="h-4 w-4" aria-hidden="true" />
        </div>
        <span className="text-base font-semibold tracking-tight">StockPulse</span>
      </div>

      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight">Choose a new password</h1>
        <p className="text-xs text-muted-foreground">
          Pick something you have not used here before. You will be signed out everywhere else.
        </p>
      </div>

      {error ? (
        <Alert tone="destructive" title="Could not reset your password">
          {describeError(error)}
        </Alert>
      ) : null}

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <Field label="New password" required error={fieldErrors.password}>
          {(props) => (
            <PasswordInput
              {...props}
              name="new-password"
              // Tells the browser (and a password manager) this is a new secret,
              // not the current one being re-typed.
              autoComplete="new-password"
              placeholder="At least 12 characters"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          )}
        </Field>

        <PasswordStrength password={password} />

        <Field label="Confirm new password" required error={fieldErrors.confirmPassword}>
          {(props) => (
            <PasswordInput
              {...props}
              name="confirm-password"
              autoComplete="new-password"
              placeholder="Re-enter your new password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
          )}
        </Field>

        <Button type="submit" loading={status === 'submitting'} className="mt-1 w-full">
          {status === 'submitting' ? 'Resetting...' : (
            <>
              <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              Reset Password
            </>
          )}
        </Button>
      </form>

      <p className="flex items-center justify-center gap-1 text-center text-2xs text-muted-foreground">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        This link works once. Resetting will not sign you in automatically.
      </p>
    </div>
  );
}
