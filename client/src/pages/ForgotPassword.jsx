import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Boxes, Send } from 'lucide-react';

import { authApi } from '../services/endpoints.js';
import { describeError, isNetworkError } from '../lib/errors.js';
import { Alert } from '../components/ui/Feedback.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Field, Input } from '../components/ui/Input.jsx';

/**
 * The one response this page ever gives, mirroring
 * PASSWORD_RESET_MESSAGE in src/modules/auth/auth.service.js.
 *
 * It is deliberately not "we sent you an email": that wording would be a lie for
 * an unknown address and would turn this form into a way to test whether
 * someone has an account here.
 */
const GENERIC_SENT_MESSAGE =
  'If an account exists with this email address, you will receive a reset link shortly.';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await authApi.forgotPassword(email);
      // Prefer the server's wording when it sends one; the two are identical by
      // design, but the API stays the single source of truth for this string.
      setSent(typeof result?.message === 'string' ? result.message : GENERIC_SENT_MESSAGE);
    } catch (caught) {
      setError(
        isNetworkError(caught)
          ? { ...caught, message: 'Cannot reach the server. Please check your connection or try again later.' }
          : caught,
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 lg:hidden">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <Boxes className="h-4 w-4" aria-hidden="true" />
        </div>
        <span className="text-base font-semibold tracking-tight">StockPulse</span>
      </div>

      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold tracking-tight">Forgot Password?</h1>
        <p className="text-xs text-muted-foreground">
          Enter the email address on your account and we will send you a link to choose a new
          password.
        </p>
      </div>

      {sent ? (
        <>
          <Alert tone="success" title="Check your email">
            {sent}
          </Alert>

          <p className="text-xs text-muted-foreground">
            The link expires after a short time and can only be used once. If it does not arrive
            within a few minutes, check your spam folder before requesting another.
          </p>
        </>
      ) : (
        <>
          {error ? (
            <Alert tone="destructive" title="Could not send the reset link">
              {describeError(error)}
            </Alert>
          ) : null}

          <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
            <Field label="Email" required>
              {(props) => (
                <Input
                  {...props}
                  type="email"
                  name="email"
                  autoComplete="username"
                  placeholder="you@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                />
              )}
            </Field>

            <Button type="submit" loading={submitting} className="mt-1 w-full">
              {submitting ? 'Sending...' : (
                <>
                  <Send className="h-4 w-4" aria-hidden="true" />
                  Send Reset Link
                </>
              )}
            </Button>
          </form>
        </>
      )}

      <p className="text-center text-xs text-muted-foreground">
        <Link
          to="/login"
          className="focus-ring inline-flex items-center gap-1 rounded font-medium text-primary hover:underline"
        >
          <ArrowLeft className="h-3 w-3" aria-hidden="true" />
          Back to Sign In
        </Link>
      </p>
    </div>
  );
}
