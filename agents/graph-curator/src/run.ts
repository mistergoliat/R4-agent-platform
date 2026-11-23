import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate, migrationStatus, withTransaction, type Pool, type PostgresArtifacts } from '@r4/persistence-postgres';
import type { StructuredLogger } from '@r4/observability';
import { walkCatalog, type ProductSheetPort } from './catalog.js';
import { applyChanges, changeOf, graphChangeSchema } from './changes.js';
import { AUTO_ACTOR, AUTO_RULES, revertChange } from './undo.js';
import { PRODUCT_GRAPH_KIND, graphStats, productGraphSchema } from './graph.js';
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
  /** (Decision 9) Mechanical changes approved and published by the curator in this run. */
  readonly automatic: { readonly approved: number; readonly version: number | null; readonly applied: number };
}

/**
 * ADR-058 G2: one on-demand curator run. Reads the signed graph, walks the catalog, applies the rules and stores the
 * run with its findings (findings in one transaction with the completed run). Changes nothing in the graph.
 */
export async function runCuration(deps: { readonly pool: Pool; readonly artifacts: Pick<PostgresArtifacts, 'current' | 'propose' | 'resolveUnseen' | 'proposals' | 'createVersion' | 'decide' | 'sign'>; readonly catalog: ProductSheetPort }, input: { readonly startedBy: string; readonly concurrency?: number; readonly tailMisses?: number }): Promise<CurationRunResult> {
  if (!(await graphSchemaIsCurrent(deps.pool))) throw new Error('the graph schema is not current: run graph:migrate first');
  const signed = await readSignedGraph(deps.artifacts);
  if (!signed) throw new Error('no signed product graph: import the baseline first (graph:import)');
  const runId = randomUUID();
  await deps.pool.query(`insert into graph.curation_runs (run_id, graph_version, started_by, status) values ($1, $2, $3, 'running')`, [runId, signed.version, input.startedBy]);
  try {
    const walk = await walkCatalog(deps.catalog, Object.keys(signed.graph.products), { ...(input.concurrency ? { concurrency: input.concurrency } : {}), ...(input.tailMisses ? { tailMisses: input.tailMisses } : {}) });
    if (walk.counts.failed > walk.counts.scanned * MAX_FAILED_READS) {
      await finish(deps.pool, runId, 'failed', walk.counts, null, `catalog reads failed: ${walk.counts.failed} of ${walk.counts.scanned}`);
      return { runId, graphVersion: signed.version, status: 'failed', catalog: walk.counts, counts: {}, proposals: { created: 0, refreshed: 0, reopened: 0, skipped: 0, resolved: 0 }, automatic: { approved: 0, version: null, applied: 0 } };
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
    // Decision 9: mechanical changes apply and publish themselves.
    const automatic = await applyAutomatic(deps.artifacts, { correlationId: `graph-curate-${runId}` });
    return { runId, graphVersion: signed.version, status: 'completed', catalog: walk.counts, counts, proposals: { ...proposals, resolved }, automatic };
  } catch (error) {
    await finish(deps.pool, runId, 'failed', null, null, (error instanceof Error ? error.message : 'unexpected_failure').slice(0, 500)).catch(() => undefined);
    throw error;
  }
}

async function finish(pool: Pool, runId: string, status: 'completed' | 'failed', catalog: object | null, counts: object | null, failure: string | null): Promise<void> {
  await pool.query(`update graph.curation_runs set status = $2, finished_at = clock_timestamp(), catalog = $3, counts = $4, failure = $5 where run_id = $1`, [runId, status, catalog && JSON.stringify(catalog), counts && JSON.stringify(counts), failure]);
}

/**
 * ADR-058 G3: builds the next version from the signed one plus the approved proposals with a change (`decidedBy`: only
 * those one actor decided). It records the version it was built on and what it includes; the proposals become applied
 * when it is signed. Not signed here: a person signs it in the console. Null when nothing is approved.
 */
export async function composeNextVersion(artifacts: Pick<PostgresArtifacts, 'current' | 'proposals' | 'createVersion'>, input: { readonly createdBy: string; readonly decidedBy?: string }): Promise<{ version: number; created: boolean; includes: number; stats: ReturnType<typeof graphStats> } | null> {
  const signed = await readSignedGraph(artifacts);
  if (!signed) throw new Error('no signed product graph');
  const approved = (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'approved')).filter((p) => p.change !== null && (input.decidedBy === undefined || p.decidedBy === input.decidedBy));
  if (!approved.length) return null;
  const graph = applyChanges(signed.graph, approved.map((p) => graphChangeSchema.parse(p.change)));
  const note = `v${signed.version} + ${approved.length} cambios ${input.decidedBy === AUTO_ACTOR ? 'automáticos' : 'aprobados'} (curador del grafo)`;
  const { version, created } = await artifacts.createVersion({ kind: PRODUCT_GRAPH_KIND, content: graph, createdBy: input.createdBy, note, baseVersion: signed.version, includes: approved.map((p) => p.proposalId) });
  return { version: version.version, created, includes: approved.length, stats: graphStats(graph) };
}

/**
 * ADR-058 Decision 9: the mechanical proposals approve themselves, and a version with only them is built and signed by
 * the curator. What a person approved and has not signed is not part of it.
 */
export async function applyAutomatic(artifacts: Pick<PostgresArtifacts, 'current' | 'proposals' | 'createVersion' | 'decide' | 'sign'>, input: { readonly correlationId: string }): Promise<{ approved: number; version: number | null; applied: number }> {
  const open = (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'proposed')).filter((p) => p.change !== null && AUTO_RULES.has(String((p.evidence as { rule?: unknown }).rule)));
  const { decided } = open.length
    ? await artifacts.decide({ kind: PRODUCT_GRAPH_KIND, proposalIds: open.map((p) => p.proposalId), decision: 'approved', decidedBy: AUTO_ACTOR, note: 'Automático (ADR-058, decisión 9)', correlationId: input.correlationId })
    : { decided: 0 };
  const composed = await composeNextVersion(artifacts, { createdBy: AUTO_ACTOR, decidedBy: AUTO_ACTOR });
  if (!composed) return { approved: decided, version: null, applied: 0 };
  const signature = await artifacts.sign({ kind: PRODUCT_GRAPH_KIND, version: composed.version, signedBy: AUTO_ACTOR, note: `${composed.includes} cambios automáticos`, correlationId: input.correlationId });
  return { approved: decided, version: composed.version, applied: signature.applied ?? 0 };
}

/**
 * Decision 9, «Deshacer»: reverts one applied change on top of the signed version (the products it touched go back to
 * how the version it was built on had them), signs that version as the person, and marks the change undone so the
 * curator never applies it again.
 */
export async function undoChange(artifacts: Pick<PostgresArtifacts, 'current' | 'proposals' | 'version' | 'createVersion' | 'sign' | 'markUndone'>, input: { readonly proposalId: string; readonly undoneBy: string; readonly correlationId: string }): Promise<{ version: number; stats: ReturnType<typeof graphStats> }> {
  const proposal = (await artifacts.proposals(PRODUCT_GRAPH_KIND, 'applied')).find((p) => p.proposalId === input.proposalId);
  if (!proposal || proposal.appliedVersion === null) throw new Error(`proposal ${input.proposalId} is not an applied change`);
  const appliedIn = await artifacts.version(PRODUCT_GRAPH_KIND, proposal.appliedVersion);
  if (appliedIn?.baseVersion == null) throw new Error(`v${proposal.appliedVersion} does not record the version it was built on: it cannot be undone change by change`);
  const base = await artifacts.version(PRODUCT_GRAPH_KIND, appliedIn.baseVersion);
  const signed = await readSignedGraph(artifacts);
  if (!base || !signed) throw new Error('the base or the signed version is missing');
  const graph = revertChange(signed.graph, productGraphSchema.parse(base.content), graphChangeSchema.parse(proposal.change));
  const { version } = await artifacts.createVersion({ kind: PRODUCT_GRAPH_KIND, content: graph, createdBy: input.undoneBy, note: `Deshacer: ${proposal.summary}`.slice(0, 500), baseVersion: signed.version });
  await artifacts.sign({ kind: PRODUCT_GRAPH_KIND, version: version.version, signedBy: input.undoneBy, note: 'Deshacer un cambio', correlationId: input.correlationId });
  await artifacts.markUndone({ kind: PRODUCT_GRAPH_KIND, proposalId: proposal.proposalId, undoneBy: input.undoneBy, note: null, correlationId: input.correlationId });
  return { version: version.version, stats: graphStats(graph) };
}
