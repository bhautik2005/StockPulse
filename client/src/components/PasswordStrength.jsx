import { Check, X } from 'lucide-react';

import { cn } from '../lib/utils.js';

/**
 * The only hard requirement, and it mirrors the server exactly.
 *
 * src/modules/auth/auth.schemas.js rejects anything shorter, so a UI that
 * accepted less would produce a form the API refuses. Everything else below is
 * advisory: the server does not demand a symbol or a digit, so neither may this
 * component block a submission for lacking one.
 */
export const PASSWORD_MIN_LENGTH = 12;

/** bcrypt truncates beyond 72 bytes; the server rejects rather than truncate. */
export const PASSWORD_MAX_LENGTH = 72;

/**
 * Scores a password and reports each guideline.
 *
 * Exported so it can be tested directly, without rendering.
 */
export function evaluatePassword(password = '') {
  const checks = [
    {
      id: 'length',
      label: `At least ${PASSWORD_MIN_LENGTH} characters`,
      met: password.length >= PASSWORD_MIN_LENGTH,
    },
    {
      id: 'case',
      label: 'Upper and lower case letters',
      met: /[a-z]/.test(password) && /[A-Z]/.test(password),
    },
    { id: 'number', label: 'At least one number', met: /\d/.test(password) },
    { id: 'symbol', label: 'At least one symbol', met: /[^A-Za-z0-9]/.test(password) },
  ];

  const score = checks.filter((check) => check.met).length;

  // Long passwords are strong even without the advisory variety checks, so
  // length is allowed to lift the verdict on its own.
  const levels = [
    { label: 'Too weak', bar: 'bg-destructive', text: 'text-destructive' },
    { label: 'Weak', bar: 'bg-destructive', text: 'text-destructive' },
    { label: 'Fair', bar: 'bg-warning', text: 'text-warning' },
    { label: 'Good', bar: 'bg-primary', text: 'text-primary' },
    { label: 'Strong', bar: 'bg-success', text: 'text-success' },
  ];

  const level = password.length >= 20 ? levels[4] : levels[score];

  return { checks, score, label: level.label, bar: level.bar, text: level.text };
}

/**
 * Strength meter plus the requirements checklist.
 *
 * Both are guidance, not validation: the submit button is never disabled by
 * this component, because a user who has a 14-character passphrase with no
 * symbol must still be able to set it.
 */
export function PasswordStrength({ password = '', className }) {
  const { checks, score, label, bar, text } = evaluatePassword(password);
  const empty = password.length === 0;

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid="password-strength">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 gap-1" role="presentation">
          {[0, 1, 2, 3].map((index) => (
            <span
              key={index}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                !empty && index < score ? bar : 'bg-muted',
              )}
            />
          ))}
        </div>
        <span
          className={cn('w-16 text-right text-2xs font-medium', empty ? 'text-muted-foreground' : text)}
          // Announced as it changes, so the meter is not a purely visual cue.
          role="status"
          aria-live="polite"
        >
          {empty ? '' : label}
        </span>
      </div>

      <ul className="flex flex-col gap-1">
        {checks.map((check) => (
          <li key={check.id} className="flex items-center gap-1.5 text-2xs">
            {check.met ? (
              <Check className="h-3 w-3 shrink-0 text-success" aria-hidden="true" />
            ) : (
              <X className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
            )}
            <span className={check.met ? 'text-muted-foreground' : 'text-muted-foreground/70'}>
              {check.label}
            </span>
            {/* The state must be readable without relying on colour. */}
            <span className="sr-only">{check.met ? 'met' : 'not met'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
