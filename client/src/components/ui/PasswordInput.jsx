import { forwardRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

import { cn } from '../../lib/utils.js';
import { Input } from './Input.jsx';

/**
 * Password field with a show/hide toggle.
 *
 * Two properties are deliberate and worth stating, because both are easy to
 * break later:
 *
 *  1. The toggle changes only the input's `type`. The input is never remounted
 *     (no `key` change) and `value` is never touched, so revealing the password
 *     cannot clear, reorder or otherwise modify what the user typed. React keeps
 *     the same DOM node, and the browser preserves the value across a type
 *     change.
 *
 *  2. The control is `type="button"`. Inside a `<form>` the default type is
 *     "submit", which would make the eye icon sign the user in.
 *
 * Everything else -- the id, `aria-invalid` and `aria-describedby` handed down
 * by `<Field>` -- is forwarded to the real `<input>`, so the toggle does not
 * disturb the label association or the error announcement.
 */
export const PasswordInput = forwardRef(function PasswordInput(
  { className, disabled, ...props },
  ref,
) {
  const [visible, setVisible] = useState(false);
  const label = visible ? 'Hide password' : 'Show password';

  return (
    <div className="relative">
      <Input
        {...props}
        ref={ref}
        // Only the type flips; the value stays exactly as the user entered it.
        type={visible ? 'text' : 'password'}
        disabled={disabled}
        // Room for the icon so it never sits on top of the typed characters.
        className={cn('pr-10', className)}
      />

      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        disabled={disabled}
        aria-label={label}
        aria-pressed={visible}
        title={label}
        className={cn(
          'focus-ring absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded',
          'text-muted-foreground transition-colors hover:text-foreground',
          'disabled:pointer-events-none disabled:opacity-50',
        )}
      >
        {visible ? (
          <Eye className="h-4 w-4" aria-hidden="true" />
        ) : (
          <EyeOff className="h-4 w-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
});
