import { pino, type DestinationStream, type Logger as PinoLogger } from 'pino';
import { currentCorrelation } from './correlation.js';

/**
 * Minimal structured-logging port. Runtime packages depend on this interface,
 * not on pino, so the logging backend stays replaceable.
 */
export interface StructuredLogger {
  debug(fields: Record<string, unknown>, message?: string): void;
  info(fields: Record<string, unknown>, message?: string): void;
  warn(fields: Record<string, unknown>, message?: string): void;
  error(fields: Record<string, unknown>, message?: string): void;
  child(bindings: Record<string, unknown>): StructuredLogger;
}

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface LoggerOptions {
  service: string;
  level?: LogLevel;
  /** Custom sink (tests capture logs through this). Defaults to stdout. */
  destination?: DestinationStream;
}

/**
 * Paths that must never be written to logs. Model prompts/outputs and agent
 * instructions are excluded by convention (telemetry logs metadata only); this
 * list is the defensive backstop for credentials.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.secret',
  '*.apiKey',
  '*.token',
  '*.accessToken',
];

export function createLogger(options: LoggerOptions): PinoLogger {
  return pino(
    {
      level: options.level ?? 'info',
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      formatters: {
        level: (label) => ({ level: label }),
      },
      // Every line carries the active correlation context automatically.
      mixin: () => {
        const ctx = currentCorrelation();
        return ctx ? { ...ctx } : {};
      },
    },
    options.destination,
  );
}

/** Logger that discards everything; for tests that do not assert on logs. */
export function createSilentLogger(): PinoLogger {
  return pino({ level: 'silent' });
}
