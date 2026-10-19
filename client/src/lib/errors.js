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
    case 429:
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 404:
      return error.message;
    case 409:
      return error.message;
    default:
      return error.message || 'Unexpected error';
  }
}

/** Field-level messages keyed by field name, for inline form errors. */
export function fieldErrorsOf(error) {
  return error?.fieldErrors ?? {};
}