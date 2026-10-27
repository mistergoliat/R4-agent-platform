#!/usr/bin/env node
// R4-J5 P0 evidence: replays the STORED compiled context of each failed run's failing iteration against the
// configured model, N times, and records only the shape of every answer (finish reason, token counts, whether the
// platform parser accepts it, the top-level JSON documents by decision type, characters outside them). No answer
// text is kept or printed. The request is rebuilt exactly as the kernel builds it (renderModelRequest).
//
//   DB=postgres://… node --env-file=<model env> scripts/canary-j4/replay-shapes.mjs --repeat 5 > shapes.jsonl
import process from 'node:process';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { parseAgentDecision, renderModelRequest } from '@r4/agent-kernel';
import { OpenAICompatibleModelProvider, loadOpenAICompatibleConfig } from '@r4-adapters/openai-compatible';
import { shapeOf } from '@r4-sales/agent';

const { values: args } = parseArgs({ options: { repeat: { type: 'string', default: '5' } } });
const repeat = Number(args.repeat);
const provider = new OpenAICompatibleModelProvider(loadOpenAICompatibleConfig(process.env));
const db = new pg.Client({ connectionString: process.env.DB });
await db.connect();

// The snapshot of the iteration whose decision was rejected as invalid_structured_output.
const { rows } = await db.query(`
  select r.run_id, r.task_id, r.agent_version, t.correlation_id, s.iteration, c.compiled_context, d.model_requirements as requirements
    from agent_run_steps s
    join agent_runs r using (run_id)
    join agent_tasks t on t.task_id = r.task_id
    join context_snapshots c on c.snapshot_id = s.context_snapshot_id
    join agent_definitions d on d.agent_id = r.agent_id and d.version = r.agent_version
   where s.error_code = 'invalid_structured_output'
   order by s.created_at`);

const out = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
for (const row of rows) {
  const context = { agent: { agentId: 'sales', modelRequirements: row.requirements }, task: { taskId: row.task_id, correlationId: row.correlation_id }, run: { runId: row.run_id } };
  const request = renderModelRequest(context, row.compiled_context, 180_000);
  const capabilities = row.compiled_context.capabilities ?? [];
  for (let attempt = 1; attempt <= repeat; attempt += 1) {
    const started = Date.now();
    try {
      const response = await provider.invoke(request, globalThis.AbortSignal.timeout(180_000));
      const parsed = parseAgentDecision(response, { capabilities, observationIds: new Set() });
      out({
        run: row.run_id.slice(0, 13), version: row.agent_version, iteration: row.iteration, attempt,
        finishReason: response.finishReason, outputTokens: response.usage.outputTokens, latencyMs: Date.now() - started,
        accepted: parsed.ok || !['invalid_structured_output', 'invalid_decision_schema', 'unknown_decision_type'].includes(parsed.error.code),
        parseError: parsed.ok ? null : parsed.error.code,
        structuredData: response.structuredData !== undefined,
        shape: response.content === null ? null : shapeOf(response.content),
      });
    } catch (error) {
      out({ run: row.run_id.slice(0, 13), attempt, error: error?.kind ?? error?.name ?? 'unknown' });
    }
  }
}
await db.end();
