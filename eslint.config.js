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
            {
              group: ['@r4/context-compiler'],
              message: 'The Agent Kernel consumes a CompiledContext through the KernelSession port; it never knows how context is built (ADR-010).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/context-compiler/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbiddenEverywhere,
            { group: ['fastify', 'fastify/*', '@r4/api', '@r4/worker', '**/apps/**'], message: 'Core packages must not depend on transports or apps.' },
            {
              group: ['pg', 'pg/*', '@r4/persistence-postgres', '@r4/task-runtime', '@r4/capability-runtime', '@r4/agent-registry', '@r4/agent-kernel', '@r4/model-gateway'],
              message: 'The Context Compiler reads only through ContextSources and ports; it never reaches storage, execution, the kernel or a model (ADR-010).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/policy-engine/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbiddenEverywhere,
            { group: ['fastify', 'fastify/*', '@r4/api', '@r4/worker', '**/apps/**'], message: 'Core packages must not depend on transports or apps.' },
            {
              group: ['pg', 'pg/*', 'node:*', '@r4/persistence-postgres', '@r4/task-runtime', '@r4/capability-runtime', '@r4/agent-registry', '@r4/agent-kernel', '@r4/model-gateway', '@r4/observability', '@r4/context-compiler'],
              message: 'The Policy Engine is pure and deterministic: no I/O, no runtime, no model (ADR-017).',
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
  // R4-F: outside Core. Domain adapters know nothing of R4; the provider adapter only its SPI;
  // the Sales pack reaches R4 through public packages, never deep imports or the task runtime.
  {
    files: ['adapters/domains/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...forbiddenEverywhere, { group: ['@r4/*', '@r4-sales/*', 'pg', 'pg/*', '**/packages/**', '**/apps/**', '**/agents/**'], message: 'Domain adapters are independent of R4 and never touch R4 persistence (R4-F).' }] },
      ],
    },
  },
  {
    files: ['adapters/models/**/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbiddenEverywhere,
            { group: ['pg', 'pg/*', '@r4/persistence-postgres', '@r4/task-runtime', '@r4/capability-runtime', '@r4/agent-kernel', '@r4/worker', '@r4/api', '@r4-sales/*', '**/packages/**'], message: 'A model provider adapter implements ModelProvider only (ADR-004, R4-F).' },
          ],
        },
      ],
    },
  },
  // R4-I: a channel adapter translates one provider's transport to/from the channel-neutral contracts of @r4/live-ops.
  // It never reaches tasks, runtimes, persistence, the kernel or a pack.
  {
    files: ['adapters/channels/**/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...forbiddenEverywhere,
            { group: ['pg', 'pg/*', '@r4/persistence-postgres', '@r4/task-runtime', '@r4/capability-runtime', '@r4/agent-kernel', '@r4/context-compiler', '@r4/worker', '@r4/api', '@r4/channel-gateway', '@r4-sales/*', '**/packages/**', '**/apps/**', '**/agents/**'], message: 'A channel adapter implements the channel-neutral contracts only (ADR-029).' },
          ],
        },
      ],
    },
  },
  {
    files: ['agents/sales/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...forbiddenEverywhere, { group: ['@r4/task-runtime', '**/packages/*/src/**', '**/apps/*/src/**', '../../packages/**', '../../apps/**'], message: 'The Sales pack uses R4 through its public packages only (R4-F).' }] },
      ],
    },
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
