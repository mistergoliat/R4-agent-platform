import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate, migrationStatus, withTransaction, type Pool, type PostgresArtifacts } from '@r4/persistence-postgres';
import type { StructuredLogger } from '@r4/observability';
import { walkCatalog, type ProductSheetPort } from './catalog.js';
import { applyChanges, changeOf, graphChangeSchema } from './changes.js';
import { PRODUCT_GRAPH_KIND, graphStats } from './graph.js';
import { countFindings, curate, fingerprintOf } from './rules.js';
import { readSignedGraph } from './signed.js';

export const GRAPH_MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

export async function migrateGraph(pool: Pool, logger?: StructuredLogger): Promise<{ applied: string[] }> {
  return migrate(pool, { directory: GRAPH_MIGRATIONS_DIR, ...(logger ? { logger } : {}) });
}
export async function graphSchemaIsCurrent(pool: Pool): Promise<boolean> {
  const s = await migrationStatus(pool, GRAPH_MIGRATIONS_DIR);
  return s.pending.length === 0 && s.modified.length === 0;
}

/** Above this share of failed catalog reads the run fails: its findings would be too partial to review. */
export const MAX_FAILED_READS = 0.05;

export interface CurationRunResult {
  readonly runId: string;
  readonly graphVersion: number;
  readonly status: 'completed' | 'failed';
  readonly catalog: { readonly scanned: number; readonly found: number; readonly notFound: number; readonly failed: number };
  readonly counts: Record<string, Record<string, number>>;
  /** (G3) Findings proposed for the person to decide in the console; already proposed, approved or rejected ones are skipped. */
  readonly proposals: { readonly created: number; readonly refreshed: number; readonly reopened: number; readonly skipped: number; readonly resolved: number };
}

/**
 * ADR-058 G2: one on-demand curator run. Reads the signed graph, walks the catalog, applies the rules and stores the
 * run with its findings (findings in one transaction with the completed run). Changes nothing in the graph.
 */
export async function runCuration(deps: { readonly pool: Pool; readonly artifacts: Pick<PostgresArtifacts, 'current' | 'propose' | 'resolveUnseen'>; readonly catalog: ProductSheetPort }, input: { readonly startedBy: string; readonly concurrency?: number; readonly tailMisses?: number }): Promise<CurationRunResult> {
  if (!(await graphSchemaIsCurrent(deps.pool))) throw new Error('the graph schema is not current: run graph:migrate first');
  const signed = await readSignedGraph(deps.artifacts);
  if (!signed) throw new Error('no signed product graph: import the baseline first (graph:import)');
  const runId = randomUUID();
  await deps.pool.query(`insert into graph.curation_runs (run_id, graph_version, started_by, status) values ($1, $2, $3, 'running')`, [runId, signed.version, input.startedBy]);
  try {
    const walk = await walkCatalog(deps.catalog, Object.keys(signed.graph.products), { ...(input.concurrency ? { concurrency: input.concurrency } : {}), ...(input.tailMisses ? { tailMisses: input.tailMisses } : {}) });
    if (walk.counts.failed > walk.counts.scanned * MAX_FAILED_READS) {
      await finish(deps.pool, runId, 'failed', walk.counts, null, `catalog reads failed: ${walk.counts.failed} of ${walk.counts.scanned}`);
      return { runId, graphVersion: signed.version, status: 'failed', catalog: walk.counts, counts: {}, proposals: { created: 0, refreshed: 0, reopened: 0, skipped: 0, resolved: 0 } };
    }
    const findings = curate(signed.graph, walk.sheets);
    const counts = countFindings(findings);
    await withTransaction(deps.pool, async (c) => {
      const rows = findings.map((f) => ({ task: f.task, rule: f.rule, product_key: f.productKey, related_key: f.relatedKey, summary: f.summary, evidence: f.evidence, fingerprint: fingerprintOf(f) }));
      await c.query(
        `insert into graph.curation_findings (run_id, task, rule, product_key, related_key, summary, evidence, fingerprint)
         select $1, r.task, r.rule, r.product_key, r.related_key, r.summary, r.evidence, r.fingerprint
           from jsonb_to_recordset($2::jsonb) as r(task text, rule text, product_key text, related_key text, summary text, evidence jsonb, fingerprint text)`,
        [runId, JSON.stringify(rows)],
      );
      await c.query(`update graph.curation_runs set status = 'completed', finished_at = clock_timestamp(), catalog = $2, counts = $3 where run_id = $1`, [runId, JSON.stringify(walk.counts), JSON.stringify(counts)]);
    });
    // G3: each finding becomes a proposal the person decides (a decided change is not proposed again; a notice that is
    // still true reopens).
    const proposals = await deps.artifacts.propose({
      kind: PRODUCT_GRAPH_KIND, baseVersion: signed.version, source: `graph-curator:${runId}`, correlationId: `graph-curate-${runId}`,
      proposals: findings.map((f) => { const { change, effect } = changeOf(f); return { fingerprint: fingerprintOf(f), summary: f.summary, evidence: { task: f.task, rule: f.rule, productKey: f.productKey, relatedKey: f.relatedKey, effect, ...f.evidence }, change }; }),
    });
    // What this run no longer finds closes by itself (a fixed sheet, a product back in stock...).
    const { resolved } = await deps.artifacts.resolveUnseen({ kind: PRODUCT_GRAPH_KIND, sourcePrefix: 'graph-curator:', seenFingerprints: findings.map(fingerprintOf), resolvedBy: `graph-curator:${runId}`, correlationId: `graph-curate-${runId}` });
    return { runId, graphVersion: signed.version, status: 'completed', catalog: walk.counts, counts, proposals: { ...proposals, resolved } };
  } catch (error) {
    await finish(deps.pool, runId, 'failed', null, null, (error instanceof Error ? error.message : 'unexpected_failure').slice(0, 500)).catch(() => undefined);
    throw error;
  }
}

async function finish(pool: Pool, runId: string, status: 'completed' | 'failed', catalog: object | null, counts: object | null, failure: string | null): Promise<void> {
  await pool.query(`update graph.curation_runs set status = $2, finished_at = clock_timestamp(), catalog = $3, counts = $4, failure = $5 where run_id = $1`, [runId, status, catalog && JSON.stringify(catalog), counts && JSON.stringify(counts), failure]);
}

/**
 * ADR-058 G3: builds the next version from the signed one plus every approved proposal with a change, and marks them
 * applied. The version is NOT signed: a person signs it in the console (artifact.sign). Null when nothing is approved.
 */
export async function composeNextVersion(artifacts: Pick<PostgresArtifacts, 'current' | 'proposals' | 'createVersion'>, input: { readonly createdBy: string; readonly correlationId: string }): Promise<{ version: number; created: boolean; applied: number; stats: ReturnType<typeof graphStats> } | null> {
  const signed = await readSignedGraph(artifacts);
  if (!signed) throw new Error('no signed product graph');
  const approved = (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'approved')).filter((p) => p.change !== null);
  if (!approved.length) return null;
  const graph = applyChanges(signed.graph, approved.map((p) => graphChangeSchema.parse(p.change)));
  const note = `v${signed.version} + ${approved.length} cambios aprobados (curador del grafo)`;
  const { version, created, applied } = await artifacts.createVersion({ kind: PRODUCT_GRAPH_KIND, content: graph, createdBy: input.createdBy, note, applies: approved.map((p) => p.proposalId), correlationId: input.correlationId });
  return { version: version.version, created, applied, stats: graphStats(graph) };
}
