import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Tests run against package sources (no build step needed).
const alias = {
  '@r4/contracts': src('./packages/contracts/src/index.ts'),
  '@r4/observability': src('./packages/observability/src/index.ts'),
  '@r4/model-gateway': src('./packages/model-gateway/src/index.ts'),
  '@r4/policy-engine': src('./packages/policy-engine/src/index.ts'),
  '@r4/capability-runtime': src('./packages/capability-runtime/src/index.ts'),
  '@r4/task-runtime': src('./packages/task-runtime/src/index.ts'),
  '@r4/agent-registry': src('./packages/agent-registry/src/index.ts'),
  '@r4/persistence-postgres': src('./packages/persistence-postgres/src/index.ts'),
  '@r4/agent-kernel': src('./packages/agent-kernel/src/index.ts'),
  '@r4/context-compiler': src('./packages/context-compiler/src/index.ts'),
  // R4-G: Quality & Learning (post-hoc evaluation; never imported by Core execution).
  '@r4/evaluation': src('./packages/evaluation/src/index.ts'),
  '@r4/evaluator': src('./apps/evaluator/src/index.ts'),
  '@r4/api': src('./apps/api/src/index.ts'),
  '@r4/worker': src('./apps/worker/src/index.ts'),
  '@r4/scheduler': src('./apps/scheduler/src/index.ts'),
  // R4-F: outside Core (adapters and the Sales agent pack).
  '@r4-adapters/domains': src('./adapters/domains/src/index.ts'),
  '@r4-adapters/openai-compatible': src('./adapters/models/openai-compatible/src/index.ts'),
  // R4-G: the Sales evaluator pack is a separate entry point (never loaded by the deployed agent). Listed first: aliases match by prefix.
  '@r4-sales/agent/evaluations': src('./agents/sales/src/evaluations/index.ts'),
  '@r4-sales/agent': src('./agents/sales/src/index.ts'),
};

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'], environment: 'node' },
      },
      {
        resolve: { alias },
        test: { name: 'contract', include: ['tests/contract/**/*.test.ts'], environment: 'node' },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/support/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        // R4-F acceptance scenarios (S01–S17 + central): scripted stand-in model, fixture domain owners, real PostgreSQL.
        resolve: { alias },
        test: {
          name: 'sales',
          include: ['tests/sales/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/support/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'recovery',
          include: ['tests/recovery/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['tests/support/global-setup.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
          // Restarts the shared database container: must not overlap other suites.
          fileParallelism: false,
        },
      },
    ],
  },
});
