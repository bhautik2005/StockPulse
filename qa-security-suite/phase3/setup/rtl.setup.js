/**
 * Phase 3 :: test environment setup (jsdom + React Testing Library).
 *
 * Three things happen here:
 *
 *   1. jest-dom matchers (`toBeInTheDocument`, `toBeDisabled`, ...) are
 *      registered, so assertions read like intent rather than like DOM queries.
 *   2. Browser APIs jsdom does not implement are polyfilled. Without these, a
 *      component that merely *imports* a charting or responsive helper throws at
 *      module scope, and the failure looks like a broken component rather than a
 *      missing test shim.
 *   3. Every test starts from a clean DOM and a clean console.
 */
/*
 * Register the jest-dom matchers EXPLICITLY, against the `expect` this test
 * graph imports.
 *
 * `import '@testing-library/jest-dom/vitest'` looks equivalent and is the
 * documented one-liner, but it resolves `vitest` from jest-dom's OWN location in
 * the dependency tree (the repository root) rather than from the running
 * runner. The project has two vitest installs -- one at the root, one in
 * client/ -- so that hidden import extends a different `expect` instance than
 * the one the test files assert with, and every `toBeInTheDocument()` fails
 * with "Invalid Chai property" while the setup file itself appears to run fine.
 *
 * Importing the matchers and extending the locally-imported `expect` pins both
 * halves to the same instance.
 */
import * as matchers from '@testing-library/jest-dom/matchers';

import { afterEach, beforeEach, expect, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

expect.extend(matchers);

// --- APIs jsdom does not implement -----------------------------------------

if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

if (!global.ResizeObserver) {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!window.IntersectionObserver) {
  window.IntersectionObserver = class IntersectionObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = vi.fn();
}

// Recharts measures its container on mount; jsdom reports 0x0, so give the
// library something to work with rather than letting it render nothing.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 400 });

/*
 * Web Storage.
 *
 * jsdom normally provides window.localStorage, but it can be absent depending on
 * how the environment is constructed -- in this repository it is: `typeof
 * window.localStorage` is 'undefined' while `window` and `document` are present.
 * An unguarded `localStorage.clear()` in afterEach then fails EVERY test in the
 * file with "Cannot read properties of undefined", which is a suite-wide failure
 * caused by a cleanup line and a miserable thing to debug.
 *
 * So use what exists and install an in-memory stand-in when it does not. The app
 * must not actually depend on Web Storage -- the session lives in an HttpOnly
 * cookie -- so this is completeness, not a crutch.
 */
function memoryStorage() {
  let store = new Map();
  return {
    get length() {
      return store.size;
    },
    key: (index) => [...store.keys()][index] ?? null,
    getItem: (key) => (store.has(String(key)) ? store.get(String(key)) : null),
    setItem: (key, value) => void store.set(String(key), String(value)),
    removeItem: (key) => void store.delete(String(key)),
    clear: () => {
      store = new Map();
    },
  };
}

for (const name of ['localStorage', 'sessionStorage']) {
  if (!window[name]) {
    Object.defineProperty(window, name, { configurable: true, writable: true, value: memoryStorage() });
  }
}

// --- determinism ------------------------------------------------------------

beforeEach(() => {
  // A component that logs a React act() warning is a real defect worth failing
  // on, but only when the suite is asked to be strict (TEST_STRICT_CONSOLE=1).
  if (process.env.TEST_STRICT_CONSOLE === '1') {
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      throw new Error(`console.error during test: ${args.join(' ')}`);
    });
    vi.spyOn(console, 'warn').mockImplementation((...args) => {
      throw new Error(`console.warn during test: ${args.join(' ')}`);
    });
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
