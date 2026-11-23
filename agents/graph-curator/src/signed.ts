import type { PostgresArtifacts } from '@r4/persistence-postgres';
import { PRODUCT_GRAPH_KIND, productGraphSchema, type ProductGraph } from './graph.js';

export interface SignedProductGraph {
  readonly version: number;
  readonly contentSha256: string;
  readonly signedBy: string;
  readonly signedAt: string;
  readonly graph: ProductGraph;
}

/** The last signed product graph (ADR-058 D1), validated; null when none was signed yet. */
export async function readSignedGraph(artifacts: Pick<PostgresArtifacts, 'current'>): Promise<SignedProductGraph | null> {
  const current = await artifacts.current(PRODUCT_GRAPH_KIND);
  if (!current) return null;
  return { version: current.version, contentSha256: current.contentSha256, signedBy: current.signedBy, signedAt: current.signedAt, graph: productGraphSchema.parse(current.content) };
}
