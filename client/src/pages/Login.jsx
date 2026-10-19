import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Boxes, LogIn } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { homePathFor } from '../lib/constants.js';
import { describeError } from '../lib/errors.js';
import { Alert } from '../components/ui/Feedback.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Field, Input } from '../components/ui/Input.jsx';

/**
 * Demo credentials, for reviewers rather than for production.
 *
 * The blueprint suggested a role selector on the sign-in form. There is no such
 * control in the API and there could not be: the role is a property of the
 * account, decided by the server on every request. A dropdown would have been a
 * lie the first time someone tried it. These buttons fill in a real account
 * instead, which is honest and one click faster.
 */
const DEMO_ACCOUNTS = [
  { role: 'Admin', email: 'admin@stockpulse.dev', password: 'AdminPass1234' },
  { role: 'Manager', email: 'manager.nairobi@stockpulse.dev', password: 'ManagerPass1234' },
  { role: 'Staff', email: 'staff.nairobi@stockpulse.dev', password: 'StaffPass1234' },
  { role: 'Client', email: 'client@acme.dev', password: 'ClientPass1234' },
];

const SHOW_DEMO = import.meta.env?.MODE !== 'production';

export function Login() {
  const { login, isAuthenticated, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Already signed in (or just signed in): go where they were headed, or to
  // wherever their role belongs.
  if (isAuthenticated) {
    return <Navigate to={location.state?.from ?? homePathFor(user?.role)} replace />;
  }

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const signedIn = await login(form);
      navigate(location.state?.from ?? homePathFor(signedIn.role), { replace: true });
    } catch (caught) {
      setError(caught);
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
        <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
        <p className="text-xs text-muted-foreground">
          Use your StockPulse account to reach the operations console.
        </p>
      </div>

      {error ? <Alert tone="destructive" title="Could not sign you in">{describeError(error)}</Alert> : null}

      <form className="flex flex-col gap-4" onSubmit={handleSubmit} noValidate>
        <Field label="Email" required>
          {(props) => (
            <Input
              {...props}
              type="email"
              name="email"
              autoComplete="username"
              placeholder="you@company.com"
              value={form.email}
              onChange={update('email')}
              required
            />
          )}
        </Field>

        <Field label="Password" required>
          {(props) => (
            <Input
              {...props}
              type="password"
              name="password"
              autoComplete="current-password"
              placeholder="••••••••••••"
              value={form.password}
              onChange={update('password')}
              required
            />
          )}
        </Field>

        <Button type="submit" loading={submitting} className="mt-1 w-full">
          {submitting ? 'Signing in…' : (
            <>
              <LogIn className="h-4 w-4" aria-hidden="true" />
              Sign in
            </>
          )}
        </Button>
      </form>

      {SHOW_DEMO ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            Seeded demo accounts
          </p>
          <div className="flex flex-wrap gap-1.5">
            {DEMO_ACCOUNTS.map((account) => (
              <Button
                key={account.role}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setForm({ email: account.email, password: account.password })}
              >
                {account.role}
              </Button>
            ))}
          </div>
          <p className="text-2xs text-muted-foreground">
            Run <code className="font-mono">npm run seed</code> in the project root to create them.
          </p>
        </div>
      ) : null}

      <p className="text-center text-xs text-muted-foreground">
        Buying from us?{' '}
        <Link to="/register" className="focus-ring rounded font-medium text-primary hover:underline">
          Create a client account
        </Link>
      </p>
    </div>
  );
}