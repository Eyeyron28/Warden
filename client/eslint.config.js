// A minimal lint setup: ESLint's recommended rules, React's, and the two hooks rules that catch real bugs. It does not
// reformat anything and has no style rules. Run: npm run lint
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'test-results/**'] },
  // Older comments in the code switch off rules this config does not enable; that is not worth a warning each.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  js.configs.recommended,
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      'react/prop-types': 'off', // the project does not use prop-types
      'react/no-unknown-property': ['error', { ignore: ['mozdirectory', 'webkitdirectory'] }], // the folder picker's non-standard attributes
      'no-control-regex': 'off', // the file-name checks match control characters on purpose
      'react/no-unescaped-entities': 'off', // apostrophes are written as &apos; where it matters; plain ones in text are fine
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    // The service worker runs in a worker, not a page.
    files: ['public/service-worker.js'],
    languageOptions: { sourceType: 'script', ecmaVersion: 2023, globals: { ...globals.serviceworker } },
  },
  {
    // Tests and scripts run in Node.
    files: ['src/**/*.test.js', 'scripts/**/*.{js,mjs}', 'vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
