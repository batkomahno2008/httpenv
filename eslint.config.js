// @ts-check
import eslint from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'node_modules/', 'scripts/']),
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // Plain JS config files are not part of a tsconfig project.
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      // Node.js scripts (e.g. the e2e harness in e2e/). Listed explicitly to
      // avoid adding the `globals` package for a handful of names.
      globals: Object.fromEntries(
        [
          'AbortController',
          'AbortSignal',
          'Buffer',
          'URL',
          'URLSearchParams',
          'TextDecoder',
          'TextEncoder',
          'clearInterval',
          'clearTimeout',
          'console',
          'fetch',
          'performance',
          'process',
          'queueMicrotask',
          'setImmediate',
          'setInterval',
          'setTimeout',
          'structuredClone',
        ].map((name) => [name, 'readonly']),
      ),
    },
    rules: {
      // plain JS cannot declare parameter or return types
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
);
