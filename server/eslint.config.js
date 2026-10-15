// A minimal lint setup for the server: ESLint's recommended rules, nothing about style. Run: npm run lint
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/**', 'coverage/**'] },
  // Older comments in the code switch off rules this config does not enable; that is not worth a warning each.
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-control-regex': 'off', // the name and input checks match control characters on purpose
      'no-empty': ['error', { allowEmptyCatch: true }], // "best effort" blocks are written as catch {} with a comment
    },
  },
];
