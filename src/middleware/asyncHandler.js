/**
 * Wraps an async route handler so a rejected promise reaches the Express error
 * pipeline instead of becoming an unhandled rejection.
 */
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};