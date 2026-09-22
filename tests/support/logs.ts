import { Writable } from 'node:stream';
import type { Logger } from 'pino';
import { createLogger } from '@r4/observability';

export interface CapturedLogs {
  readonly logger: Logger;
  readonly lines: Record<string, unknown>[];
  readonly raw: () => string;
  events(name: string): Record<string, unknown>[];
}

/** A real pino logger whose output is captured for assertions. */
export function captureLogs(service = 'r4-test'): CapturedLogs {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ service, level: 'debug', destination });
  const lines: Record<string, unknown>[] = [];
  const parse = () => {
    lines.length = 0;
    for (const line of chunks.join('').split('\n')) {
      if (line.trim()) lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    return lines;
  };
  return {
    logger,
    get lines() {
      return parse();
    },
    raw: () => chunks.join(''),
    events: (name) => parse().filter((line) => line.event === name),
  };
}
