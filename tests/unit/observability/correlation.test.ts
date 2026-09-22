import { describe, expect, it } from 'vitest';
import { uuidSchema } from '@r4/contracts';
import { emitTelemetry, resolveCorrelationId, runWithCorrelation, withCorrelationFields } from '@r4/observability';
import { captureLogs } from '../../support/logs.js';

describe('correlation', () => {
  it('accepts well-formed caller correlation ids', () => {
    expect(resolveCorrelationId('req-123:abc')).toBe('req-123:abc');
    expect(resolveCorrelationId(['first', 'second'])).toBe('first');
  });

  it.each([undefined, '', 'has space', 'x'.repeat(200), 'line\nbreak', '{"json":1}', 42])(
    'replaces malformed or missing ids (%j) with a generated one',
    (candidate) => {
      const id = resolveCorrelationId(candidate);
      expect(uuidSchema.safeParse(id).success).toBe(true);
    },
  );

  it('stamps every log line with the active correlation context', async () => {
    const logs = captureLogs();
    await runWithCorrelation({ correlationId: 'corr-A' }, async () => {
      logs.logger.info({ step: 1 }, 'outer');
      await withCorrelationFields({ taskId: 'task-1', runId: 'run-1', agentId: 'agent-1' }, async () => {
        await Promise.resolve();
        emitTelemetry(logs.logger, 'run.started', { sequence: 1 });
      });
    });
    logs.logger.info({}, 'outside');

    const [outer, event, outside] = logs.lines;
    expect(outer).toMatchObject({ correlationId: 'corr-A', service: 'r4-test', level: 'info' });
    expect(event).toMatchObject({ correlationId: 'corr-A', taskId: 'task-1', runId: 'run-1', agentId: 'agent-1', event: 'run.started' });
    expect(outside).not.toHaveProperty('correlationId');
  });

  it('redacts credentials', () => {
    const logs = captureLogs();
    logs.logger.info({ headers: { authorization: 'Bearer abc' }, db: { password: 'hunter2' } }, 'x');
    expect(logs.raw()).not.toContain('Bearer abc');
    expect(logs.raw()).not.toContain('hunter2');
  });
});
