/// <reference types="vitest/globals" />
/// <reference types="@testing-library/jest-dom" />

/**
 * Ambient declarations for the QA suite.
 *
 * Exists purely so `vite.config.js` / `vitest.config.js` files that reference
 * `qa-security-suite/phase1/setup/rtl.setup.js` and the jest-dom matchers
 * (`toBeInTheDocument`) type-check in editors. Vitest does not need it to run.
 */
