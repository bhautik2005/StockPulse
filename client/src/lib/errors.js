/**
 * Turns an ApiError into something worth reading.
 *
 * The server is deliberately specific -- it has a machine-readable `code` and
 * often structured `details` -- and this is where that specificity is spent
 * rather than flattened into "something went wrong".
 */
export function describeError(error) {
  if (!error) return null;

  switch (error.status) {
    case 0:
      return error.message;
    case 401:
      // The API answers identically for an unknown email and a wrong password,
      // on purpose; this message must not undo that.
      return 'Email or password is incorrect.';
    case 403:
      return error.message;
    case 409:
      // Check for specific conflict codes
      if (error.code === 'USER_EXISTS') {
        return 'An account with this email already exists. Please sign in instead.';
      }
      if (error.code === 'EMAIL_TAKEN') {
        return 'This email is already registered. Please sign in or use a different email.';
      }
      return error.message || 'A conflict occurred. Please try again.';
    case 422:
      return error.message || 'Validation failed. Please check your input.';
    case 429:
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 404:
      return error.message;
    default:
      return error.message || 'Unexpected error';
  }
}

/** Field-level messages keyed by field name, for inline form errors. */
export function fieldErrorsOf(error) {
  return error?.fieldErrors ?? {};
}

/** Check if error is a network connectivity issue */
export function isNetworkError(error) {
  return error?.status === 0 || error?.code === 'NETWORK_ERROR';
}

/** Check if error is an authentication error (expired/revoked session) */
export function isAuthError(error) {
  return error?.status === 401 && error?.code !== 'UNAUTHENTICATED';
}

/** Check if error is a conflict error (409) */
export function isConflictError(error) {
  return error?.status === 409;
}