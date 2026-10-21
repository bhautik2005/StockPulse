import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Boxes, UserPlus } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { homePathFor } from '../lib/constants.js';
import { describeError, isConflictError, fieldErrorsOf } from '../lib/errors.js';
import { Alert } from '../components/ui/Feedback.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Field, Input } from '../components/ui/Input.jsx';

/** Mirrors the server's rules so the user is corrected before a round trip. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(form) {
  const errors = {};

  if (form.name.trim().length < 2) errors.name = 'Enter your name (at least 2 characters).';
  if (!EMAIL_PATTERN.test(form.email.trim())) errors.email = 'Enter a valid email address.';

  // bcrypt only reads the first 72 bytes, so the server rejects longer input
  // rather than silently truncating it -- the form says the same thing.
  if (form.password.length < 12) errors.password = 'Use at least 12 characters.';
  else if (form.password.length > 72) errors.password = 'Use at most 72 characters.';

  if (form.confirm !== form.password) errors.confirm = 'The two passwords do not match.';

  return errors;
}

export function Register() {
  const { register, isAuthenticated, user } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) return <Navigate to={homePathFor(user?.role)} replace />;

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);

    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      const created = await register({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
      });
      navigate(homePathFor(created.role), { replace: true });
    } catch (caught) {
      // Handle 409 conflict specifically - user already exists
      if (isConflictError(caught)) {
        // For register, 409 typically means email already registered
        setError(caught);
        setErrors({ email: describeError(caught) });
      } else {
        setError(caught);
      }
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
        <h1 className="text-lg font-semibold tracking-tight">Create a client account</h1>
        <p className="text-xs text-muted-foreground">
          Browse the catalogue and place orders. Staff and manager accounts are created by an
          administrator.
        </p>
      </div>

      {error ? (
        <Alert tone="destructive" title="Could not create your account">
          {describeError(error)}
        </Alert>
      ) : null}

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <Field label="Full name" required error={errors.name}>
          {(props) => (
            <Input
              {...props}
              name="name"
              autoComplete="name"
              placeholder="Acme Procurement"
              value={form.name}
              onChange={update('name')}
            />
          )}
        </Field>

        <Field label="Work email" required error={errors.email}>
          {(props) => (
            <Input
              {...props}
              type="email"
              name="email"
              autoComplete="username"
              placeholder="you@company.com"
              value={form.email}
              onChange={update('email')}
            />
          )}
        </Field>

        <Field label="Password" required error={errors.password} hint="At least 12 characters.">
          {(props) => (
            <Input
              {...props}
              type="password"
              name="password"
              autoComplete="new-password"
              value={form.password}
              onChange={update('password')}
            />
          )}
        </Field>

        <Field label="Confirm password" required error={errors.confirm}>
          {(props) => (
            <Input
              {...props}
              type="password"
              name="confirm"
              autoComplete="new-password"
              value={form.confirm}
              onChange={update('confirm')}
            />
          )}
        </Field>

        <Button type="submit" loading={submitting} className="mt-1 w-full">
          {submitting ? 'Creating account…' : (
            <>
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              Create account
            </>
          )}
        </Button>
      </form>

      <p className="text-center text-xs text-muted-foreground">
        Already have an account?{' '}
        <Link to="/login" className="focus-ring rounded font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}