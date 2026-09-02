import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/**
 * Lint configuration.
 *
 * Deliberately narrow: type-aware linting across a monorepo this size costs more in CI
 * minutes than it catches, given `tsc --noEmit` already runs on every package with
 * `strict` plus `noUncheckedIndexedAccess`. What remains are the rules that TypeScript
 * does not enforce — unused code, unsafe escapes, and the `any` casts that would quietly
 * undo the strictness everywhere else.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      'packages/database/prisma/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  {
    // Scripts, seeds and the CLI are console programs; printing is the point. These are
    // also plain Node modules rather than bundled source, so they need Node's globals
    // declared — `js.configs.recommended` alone treats `process` as undefined.
    files: ['scripts/**', '**/seed.ts', 'apps/cli/**', '**/*.config.*', '**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
      },
    },
    rules: { 'no-console': 'off' },
  },
  {
    // Tests assert on shapes the production types deliberately narrow.
    files: ['**/test/**', '**/*.test.ts', '**/e2e/**'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier,
);
