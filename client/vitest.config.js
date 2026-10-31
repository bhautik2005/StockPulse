/**
 * Vitest configuration for the StockPulse frontend QA suite (Phase 3).
 *
 * Why Phase 3 has its own config
 * ------------------------------
 * Phase 3 renders React components, and the frontend owns React. Rooting the run
 * in the client directory means every bare import (react, react-dom,
 * react-router-dom, @testing-library/*) resolves inside the CLIENT's dependency
 * tree, where exactly one copy of each exists.
 *
 * That matters more than it sounds. React stores its hooks dispatcher on the
 * module instance, so two copies of React in one process make every hook read
 * null:
 *
 *   Cannot read properties of null (reading 'useRef')
 *
 * The project root has its own React install (pulled in by @testing-library), so a
 * Phase 3 run rooted anywhere else resolves `react` from one tree and `react-dom`
 * from the other. The error blames the component rather than the resolver, which
 * is a genuinely confusing thing to debug. Rooting here removes the possibility
 * instead of working around it.
 *
 * The suite directory sits outside this package, so Vite's file-serving allow list
 * has to include the repository root as well as this directory.
 *
 * Run it with:
 *   cd client && npm run qa:phase3
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const CLIENT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CLIENT, '..');
const SUITE = path.join(REPO_ROOT, 'qa-security-suite');
const toPosix = (value) => value.replace(/\\/g, '/');
const SUITE_FROM_CLIENT = path.relative(CLIENT, SUITE);

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: [
      { find: /^react$/, replacement: path.join(CLIENT, 'node_modules/react') },
      { find: /^react-dom(\/.*)?$/, replacement: path.join(CLIENT, 'node_modules/react-dom') },
      { find: /^react-router-dom$/, replacement: path.resolve(CLIENT, 'node_modules/react-router-dom') },
      { find: /^@testing-library\/react$/, replacement: path.resolve(CLIENT, 'node_modules/@testing-library/react') },
    ],
  },

  server: {
    fs: { allow: [CLIENT, SUITE, REPO_ROOT] },
  },

  test: {
    root: CLIENT,
    environment: 'jsdom',
    globals: true,
    css: false,
    clearMocks: true,
    restoreMocks: true,
    include: [toPosix(path.join(SUITE_FROM_CLIENT, 'phase3', '**', '*.test.jsx'))],
    setupFiles: [toPosix(path.join(SUITE, 'phase3', 'setup', 'rtl.setup.js'))],
    testTimeout: 20_000,
  },
});
