import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Flat ESLint config for the console.
 *
 * The rules that earn their place here are `no-undef` and `no-unused-vars`:
 * a mistyped identifier or an import left behind after a refactor is exactly
 * the class of mistake a bundler will happily ship. The React Hooks rules
 * catch the other classic source of front-end bugs -- a dependency list that
 * does not match what the effect actually reads.
 */
export default [
  { ignores: ['dist/**', 'node_modules/**', 'verify-out/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // The dev server config and build scripts run in Node, not the browser.
    files: ['vite.config.js', 'postcss.config.js', 'tailwind.config.js', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
];