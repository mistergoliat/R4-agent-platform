import type { PostgresArtifacts } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND, graphStats, productGraphSchema } from './graph.js';

/**
 * ADR-058 G1 / owner decision 1: today's graph becomes a signed version, its unreviewed relations marked. Idempotent:
 * the same content reuses its version, and a version already current is not signed again.
 */
export async function importSignedGraph(
  artifacts: Pick<PostgresArtifacts, 'createVersion' | 'sign' | 'current'>,
  input: { readonly graph: unknown; readonly unreviewed: readonly unknown[]; readonly signedBy: string; readonly note: string | null; readonly correlationId: string },
): Promise<{ version: number; contentSha256: string; created: boolean; signed: boolean; stats: ReturnType<typeof graphStats> }> {
  const graph = productGraphSchema.parse({ ...(input.graph as object), unreviewed: input.unreviewed });
  const { version, created } = await artifacts.createVersion({ kind: PRODUCT_GRAPH_KIND, content: graph, createdBy: input.signedBy, note: input.note });
  const current = await artifacts.current(PRODUCT_GRAPH_KIND);
  const signed = current?.version !== version.version;
  if (signed) await artifacts.sign({ kind: PRODUCT_GRAPH_KIND, version: version.version, signedBy: input.signedBy, note: input.note, correlationId: input.correlationId });
  return { version: version.version, contentSha256: version.contentSha256, created, signed, stats: graphStats(graph) };
}
