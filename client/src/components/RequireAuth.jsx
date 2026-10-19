import { Navigate, useLocation } from 'react-router-dom';
import { Loader2, ShieldOff } from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { INTERNAL_ROLES } from '../lib/constants.js';
import { Button } from './ui/Button.jsx';

function FullPageSpinner() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
        <p className="text-xs text-muted-foreground">Restoring your session…</p>
      </div>
    </div>
  );
}

/**
 * Gate for authenticated areas.
 *
 * While the session is being restored we render a spinner rather than
 * redirecting: bouncing an already-signed-in user to /login on every reload
 * (before /me has answered) is a classic and irritating bug.
 */
export function RequireAuth({ children }) {
  const { isAuthenticated, isLoading, bootError, refresh } = useAuth();
  const location = useLocation();

  if (isLoading) return <FullPageSpinner />;

  if (!isAuthenticated) {
    if (bootError) {
      // Not a session problem: the API is unreachable. Say so, and offer a retry.
      return (
        <div className="flex h-screen items-center justify-center bg-background p-6">
          <div className="flex max-w-md flex-col items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
            <ShieldOff className="h-6 w-6 text-destructive" aria-hidden="true" />
            <h1 className="text-sm font-semibold">Cannot reach the StockPulse API</h1>
            <p className="text-xs text-muted-foreground">{bootError.message}</p>
            <p className="text-2xs text-muted-foreground">
              Start the API with <code className="font-mono">npm run dev</code> in the project root.
            </p>
            <Button size="sm" variant="outline" onClick={refresh}>
              Try again
            </Button>
          </div>
        </div>
      );
    }

    // Remember where they were headed so sign-in can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return children;
}

/** Gate for pages only some roles may open. */
export function RequireRole({ roles, children }) {
  const { user } = useAuth();

  if (!user || !roles.includes(user.role)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-2 rounded-lg border border-border bg-card p-6 text-center">
          <ShieldOff className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-sm font-semibold">Not available for your role</h1>
          <p className="text-xs text-muted-foreground">
            This page requires one of: {roles.join(', ')}. You are signed in as {user?.role ?? 'unknown'}.
          </p>
          <Button size="sm" variant="outline" onClick={() => window.history.back()}>
            Go back
          </Button>
        </div>
      </div>
    );
  }

  return children;
}

/** Convenience wrapper for the internal (non-Client) pages. */
export function RequireInternal({ children }) {
  return <RequireRole roles={INTERNAL_ROLES}>{children}</RequireRole>;
}

export { FullPageSpinner };