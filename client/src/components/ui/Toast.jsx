import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';

import { cn } from '../../lib/utils.js';

const ToastContext = createContext(null);

const TONES = {
  success: { icon: CheckCircle2, className: 'border-success/40 bg-success/10 text-success' },
  error: { icon: AlertTriangle, className: 'border-destructive/40 bg-destructive/10 text-destructive' },
  info: { icon: Info, className: 'border-border bg-popover text-foreground' },
};

function Toast({ toast, onDismiss }) {
  const { icon: Icon, className } = TONES[toast.tone] ?? TONES.info;

  useEffect(() => {
    // Errors stay longer: they usually carry something to read and act on.
    const timer = setTimeout(() => onDismiss(toast.id), toast.tone === 'error' ? 8000 : 4500);
    return () => clearTimeout(timer);
  }, [toast.id, toast.tone, onDismiss]);

  return (
    <div
      className={cn(
        'pointer-events-auto flex w-80 items-start gap-3 rounded-md border bg-popover/95 p-3 shadow-lg backdrop-blur animate-scale-in',
        className,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="flex flex-1 flex-col gap-0.5">
        <p className="text-sm font-medium">{toast.title}</p>
        {toast.description ? (
          <p className="text-xs text-muted-foreground">{toast.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="focus-ring rounded text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((toast) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((current) => [...current, { id, tone: 'info', ...toast }]);
    return id;
  }, []);

  const value = useMemo(
    () => ({
      toast: push,
      success: (title, description) => push({ title, description, tone: 'success' }),
      error: (title, description) => push({ title, description, tone: 'error' }),
      info: (title, description) => push({ title, description, tone: 'info' }),
      dismiss,
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div
          // Announced to screen readers without stealing focus from the form
          // the user is still working in.
          role="region"
          aria-live="polite"
          aria-label="Notifications"
          className="pointer-events-none fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
        >
          {toasts.map((toast) => (
            <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside a ToastProvider');
  return context;
}