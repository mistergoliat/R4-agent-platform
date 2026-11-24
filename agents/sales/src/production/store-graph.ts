import type { StructuredLogger } from '@r4/observability';
import { parseGraph, type GraphFile } from '../capabilities/catalog-build-step.js';

/** ADR-058: the Core artifact kind of the owner-signed store graph (written by the graph-curator pack). */
export const STORE_GRAPH_KIND = 'product-graph';
/** How often the worker looks for a newer signed version (the curator publishes weekly; a person signs any time). */
export const STORE_GRAPH_REFRESH_MS = 10 * 60_000;

/** Reads the current signed version (the deployment binds it to Core's artifacts; see cli/production.ts). */
export type SignedRead = () => Promise<{ readonly version: number; readonly content: unknown } | null>;

/**
 * ADR-058 G5: the store graph the web tools read is the last signed version, not a copied file. Loaded at start (a
 * malformed one stops the start), then refreshed in the background; a failed or malformed refresh keeps the version
 * in use and logs it, so the tools never run on half a graph.
 */
export class SignedStoreGraph {
  #graph: GraphFile;
  #version: number;
  readonly #read: SignedRead;
  readonly #logger: StructuredLogger;
  #timer: ReturnType<typeof setInterval> | null = null;

  private constructor(graph: GraphFile, version: number, read: SignedRead, logger: StructuredLogger) {
    this.#graph = graph;
    this.#version = version;
    this.#read = read;
    this.#logger = logger;
  }

  /** The signed graph, or null when nothing is signed yet (the caller may fall back to the exported file). */
  static async load(read: SignedRead, logger: StructuredLogger): Promise<SignedStoreGraph | null> {
    const signed = await read();
    if (!signed) return null;
    const graph = parseGraph(signed.content, `${STORE_GRAPH_KIND} v${signed.version}`);
    logger.info({ event: 'store_graph.loaded', source: 'signed', version: signed.version, products: Object.keys(graph.products).length }, 'store graph loaded');
    return new SignedStoreGraph(graph, signed.version, read, logger);
  }

  get(): GraphFile {
    return this.#graph;
  }

  get version(): number {
    return this.#version;
  }

  /** Swaps in a newer signed version; keeps the current one when the read fails or is malformed. */
  async refresh(): Promise<boolean> {
    try {
      const signed = await this.#read();
      if (!signed || signed.version === this.#version) return false;
      this.#graph = parseGraph(signed.content, `${STORE_GRAPH_KIND} v${signed.version}`);
      this.#logger.info({ event: 'store_graph.refreshed', from: this.#version, to: signed.version }, 'store graph refreshed');
      this.#version = signed.version;
      return true;
    } catch (error) {
      this.#logger.warn({ event: 'store_graph.refresh_failed', version: this.#version, err: error instanceof Error ? error.message.slice(0, 200) : 'unexpected' }, 'store graph refresh failed; keeping the version in use');
      return false;
    }
  }

  /** Refreshes every `intervalMs` without keeping the process alive. */
  start(intervalMs: number = STORE_GRAPH_REFRESH_MS): this {
    this.#timer ??= setInterval(() => void this.refresh(), intervalMs);
    this.#timer.unref?.();
    return this;
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
