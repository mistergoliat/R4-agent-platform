// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint also encodes architecture boundaries (see docs/architecture/R4_ARCHITECTURE.md):
 * - Core packages may not import transports, apps, UI frameworks or CRM code.
 * - Only the persistence adapter may talk to PostgreSQL.
 * - The model gateway may not reach persistence or capability execution.
 */
const forbiddenEverywhere = [
  { group: ['next', 'next/*', 'react', 'react-dom', 'react/*'], message: 'R4 must not depend on Next.js/React (ADR-001).' },
  { group: ['**/CRM-Customer-360/**', '@pesaschile/*', '**/hub/**'], message: 'R4 must not import CRM code (ADR-001).' },
  { group: ['langchain', '@langchain/*', 'langgraph', '@langchain/langgraph'], message: 'No agent framework as architectural foundation.' },
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/only-throw-error': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
      'no-restricted-imports': ['error', { patterns: forbiddenEverywhere }],
    },
  },
  {
    files: ['packages/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbiddenEverywhere,
            { group: ['fastify', 'fastify/*', '@r4/api', '**/apps/**'], message: 'Core packages must not depend on transports or apps.' },
            { group: ['**/packages/*/src/**', '../../*/src/**'], message: 'Import other packages by their public name (@r4/...).' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/*/src/**/*.ts'],
    ignores: ['packages/persistence-postgres/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbiddenEverywhere,
            { group: ['fastify', 'fastify/*', '@r4/api', '**/apps/**'], message: 'Core packages must not depend on transports or apps.' },
            { group: ['**/packages/*/src/**', '../../*/src/**'], message: 'Import other packages by their public name (@r4/...).' },
            { group: ['pg', 'pg/*', '@r4/persistence-postgres'], message: 'Only the persistence adapter talks to PostgreSQL; depend on ports.' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/model-gateway/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbiddenEverywhere,
            { group: ['fastify', 'fastify/*', '@r4/api', '**/apps/**'], message: 'Core packages must not depend on transports or apps.' },
            { group: ['pg', 'pg/*', '@r4/persistence-postgres', '@r4/task-runtime', '@r4/capability-runtime', '@r4/agent-registry'], message: 'The model gateway returns proposals only; it cannot reach state or execute capabilities (ADR-004).' },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/agent-kernel/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbiddenEverywhere,
            { group: ['fastify', 'fastify/*', '@r4/api', '@r4/worker', '**/apps/**'], message: 'Core packages must not depend on transports or apps.' },
            {
              group: ['pg', 'pg/*', '@r4/persistence-postgres', '@r4/task-runtime', '@r4/capability-runtime', '@r4/agent-registry'],
              message: 'The Agent Kernel reaches state and capability execution only through the KernelSession port (ADR-009).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/*/src/main.ts', 'apps/*/src/migrate.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
  {
    files: ['eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Plain-JS child processes spawned by recovery tests (Node cannot run TS directly).
    files: ['tests/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { ...tseslint.configs.disableTypeChecked.languageOptions, globals: { process: 'readonly' } },
  },
);
