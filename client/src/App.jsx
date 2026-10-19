import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { Compass } from 'lucide-react';

import { ErrorBoundary } from './components/ErrorBoundary.jsx';
import { RequireAuth, RequireInternal, RequireRole, FullPageSpinner } from './components/RequireAuth.jsx';
import { useAuth } from './context/AuthContext.jsx';
import { DashboardLayout } from './layouts/DashboardLayout.jsx';
import { AuthLayout } from './layouts/AuthLayout.jsx';
import { homePathFor, ROLES } from './lib/constants.js';
import { Dashboard } from './pages/Dashboard.jsx';
import { Inventory } from './pages/Inventory.jsx';
import { Login } from './pages/Login.jsx';
import { Orders } from './pages/Orders.jsx';
import { Products } from './pages/Products.jsx';
import { Register } from './pages/Register.jsx';
import { Users } from './pages/Users.jsx';
import { Warehouses } from './pages/Warehouses.jsx';

/** Sends each visitor to the place their role can actually use. */
function RootRedirect() {
  const { isAuthenticated, isLoading, user } = useAuth();

  if (isLoading) return <FullPageSpinner />;
  return <Navigate to={isAuthenticated ? homePathFor(user?.role) : '/login'} replace />;
}

function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <Compass className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <h1 className="text-base font-semibold">Page not found</h1>
        <p className="text-xs text-muted-foreground">
          That route does not exist in the console.
        </p>
        <Link
          to="/"
          className="focus-ring rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
        >
          Back to StockPulse
        </Link>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Routes>
      {/* Signed-out routes */}
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
      </Route>

      {/* Signed-in routes. RequireAuth restores the session from the HttpOnly
          cookie before deciding, so a reload never bounces a real user out. */}
      <Route
        element={
          <RequireAuth>
            <DashboardLayout />
          </RequireAuth>
        }
      >
        <Route
          path="/dashboard"
          element={
            <RequireInternal>
              <ErrorBoundary>
                <Dashboard />
              </ErrorBoundary>
            </RequireInternal>
          }
        />
        <Route
          path="/warehouses"
          element={
            <RequireInternal>
              <ErrorBoundary>
                <Warehouses />
              </ErrorBoundary>
            </RequireInternal>
          }
        />
        <Route
          path="/inventory"
          element={
            <RequireInternal>
              <ErrorBoundary>
                <Inventory />
              </ErrorBoundary>
            </RequireInternal>
          }
        />
        {/* Available to every role; the page itself adapts to what the role may
            request (catalogue management vs. availability only). */}
        <Route
          path="/products"
          element={
            <ErrorBoundary>
              <Products />
            </ErrorBoundary>
          }
        />
        <Route
          path="/orders"
          element={
            <ErrorBoundary>
              <Orders />
            </ErrorBoundary>
          }
        />
        <Route
          path="/users"
          element={
            <RequireRole roles={[ROLES.ADMIN]}>
              <ErrorBoundary>
                <Users />
              </ErrorBoundary>
            </RequireRole>
          }
        />
      </Route>

      <Route path="/" element={<RootRedirect />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}