import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

/** Worker presence (R4-I, 0008) is generic execution-plane evidence. */
const GENERIC = [
  'packages/persistence-postgres/migrations/0008_worker_presence.sql',
  'packages/persistence-postgres/src/worker-presence-store.ts',
  'packages/task-runtime/src/worker-presence.ts',
  'apps/worker/src/presence.ts',
];

describe('worker presence boundaries (R4-I)', () => {
  it.each(GENERIC)('%s is channel-, provider- and pack-neutral', (file) => {
    const source = read(file).toLowerCase();
    for (const forbidden of ['whatsapp', 'meta', 'sales', 'quote', 'catalog', 'customer', 'openai', 'deepseek', 'n8n']) {
      expect(source, `${file} mentions ${forbidden}`).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it('persists only presence facts: no host, environment, secret, configuration or control state', () => {
    const migration = read('packages/persistence-postgres/migrations/0008_worker_presence.sql');
    const columns = [...migration.matchAll(/^\s{2}([a-z_]+)\s+(?:text|timestamptz)/gm)].map((m) => m[1]);
    expect(columns).toEqual(['worker_id', 'execution_mode', 'compatibility', 'build_ref', 'state', 'reason', 'started_at', 'heartbeat_at', 'expires_at']);
    expect(migration).not.toMatch(/\bnow\(\)/);
  });

  it('the worker publishes presence from its own progress, never from a timer of its own', () => {
    const presence = read('apps/worker/src/presence.ts');
    expect(presence).not.toMatch(/setInterval|setTimeout/);
  });
});
