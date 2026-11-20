import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPlatform, type ApiConfig, type Platform } from '@r4/api';
import { createSilentLogger } from '@r4/observability';
import { ACTION_AGENTS_DIR } from '../support/actions.js';
import { createMigratedTestDatabase, type TestDatabase } from '../support/database.js';

/**
 * ADR-054 (W1): agent drafts through the API. Reads with the service reader; writes only from a signed operator
 * with agent.draft. A draft is a reduction of a REGISTERED base, each save is an immutable revision, and nothing is
 * ever registered in agent_definitions.
 */
const KEY = randomBytes(32).toString('base64url');
const ISS = 'https://accounts.google.com';
const SUB = '109876543210987654321';
const TOKEN = 'console-reader-token-0123456789abcdef0123456789';
const BEARER = { authorization: `Bearer ${TOKEN}` };
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code: string } }).error?.code;

let db: TestDatabase;
let platform: Platform;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
  const dir = mkdtempSync(join(tmpdir(), 'r4-drafts-it-'));
  const operatorsFile = join(dir, 'operators.json');
  writeFileSync(operatorsFile, JSON.stringify([{ issuer: ISS, subject: SUB, operatorRef: 'felipe', scopes: ['agent.draft', 'knowledge.curate'] }]), { mode: 0o600 });
  const config: ApiConfig = {
    databaseUrl: db.url, host: '127.0.0.1', port: 0, logLevel: 'silent', agentDefinitionsDir: ACTION_AGENTS_DIR, dbPoolMax: 4,
    serviceReaderTokenSha256: createHash('sha256').update(TOKEN).digest('hex'), consoleOperatorKey: KEY, consoleOperatorsFile: operatorsFile, anonymousWrites: 'disabled',
  };
  platform = await createPlatform(config, { logger: createSilentLogger() });
}, 120_000);

afterAll(async () => {
  await platform?.close();
  await db?.drop();
});

function assertion(path: string, body: string, scopes: string[]): string {
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ v: 1, iss: ISS, sub: SUB, scopes, method: 'POST', path, bodySha256: createHash('sha256').update(body).digest('hex'), iat, exp: iat + 60, jti: randomUUID() }),
  ).toString('base64url');
  return `v1.${payload}.${createHmac('sha256', Buffer.from(KEY, 'base64url')).update(`v1.${payload}`).digest('base64url')}`;
}
const post = (path: string, body: object, scopes = ['agent.draft'], headers?: Record<string, string>) => {
  const payload = JSON.stringify(body);
  return platform.app.inject({ method: 'POST', url: path, payload, headers: { 'content-type': 'application/json', ...(headers ?? { 'x-r4-console-assertion': assertion(path, payload, scopes) }) } });
};
const get = (url: string, headers: Record<string, string> = BEARER) => platform.app.inject({ method: 'GET', url, headers });

const BUDGETS = { maxDurationMs: 120000, maxModelCalls: 20, maxCapabilityCalls: 20, maxWrites: 5, maxDelegations: 0 };
const EDITS = { displayName: 'Probe · Instagram', description: 'Draft for a new channel', instructions: 'Short replies.', capabilityScopes: ['platform_test.read'], budgets: { ...BUDGETS, maxModelCalls: 10 } };
const CREATE = { agentId: 'action-probe-instagram', base: { agentId: 'action-probe', version: 1 }, template: 'channel', channel: 'instagram', ...EDITS, note: 'primer borrador' };

interface Draft { draftId: string; agentId: string; state: string; revision: number; createdBy: string; updatedBy: string; channel: string | null; label: string | null }
interface Revision { revision: number; definition: { agentId: string; version: number; capabilityScopes: string[]; budgets: Record<string, number>; instructions: string }; note: string | null; createdBy: string }

describe('agent drafts', () => {
  let draftId = '';

  it('writes need a signed operator with agent.draft; the service token is refused', async () => {
    for (const [scopes, headers] of [[[], BEARER], [[], {}]] as const) {
      const res = await post('/v1/agent-drafts', CREATE, [...scopes], headers);
      expect([res.statusCode, code(res)]).toEqual([422, 'trusted_human_required']);
    }
    const noScope = await post('/v1/agent-drafts', CREATE, ['knowledge.curate']);
    expect([noScope.statusCode, code(noScope)]).toEqual([422, 'human_scope_denied']);
    expect((await platform.pool.query('select * from agent_drafts')).rows).toEqual([]);
  });

  it('reads need the service reader or a person', async () => {
    expect((await get('/v1/agent-drafts', {})).statusCode).toBe(422);
    expect((await get('/v1/agent-drafts')).json()).toEqual({ drafts: [] });
  });

  it('creates a draft from a registered base, as revision 1, and registers nothing', async () => {
    const res = await post('/v1/agent-drafts', CREATE);
    expect(res.statusCode, res.body).toBe(201);
    const { draft, revision } = res.json<{ draft: Draft; revision: Revision }>();
    draftId = draft.draftId;
    expect(draft).toMatchObject({ agentId: 'action-probe-instagram', state: 'draft', revision: 1, createdBy: 'oidc:felipe', channel: 'instagram' });
    expect(revision).toMatchObject({ revision: 1, note: 'primer borrador', definition: { agentId: 'action-probe-instagram', version: 1, capabilityScopes: ['platform_test.read'] } });
    expect(revision.definition.budgets.maxModelCalls).toBe(10);
    expect((await platform.pool.query(`select 1 from agent_definitions where agent_id = 'action-probe-instagram'`)).rowCount).toBe(0);
    const again = await post('/v1/agent-drafts', CREATE);
    expect([again.statusCode, code(again)]).toEqual([409, 'agent_draft_open']);
  });

  it.each([
    ['a capability the base lacks', { ...CREATE, agentId: 'x-one', capabilityScopes: ['platform_test.read', 'payments.write'] }, 'capability_not_in_base'],
    ['a budget above the base', { ...CREATE, agentId: 'x-two', budgets: { ...BUDGETS, maxModelCalls: 21 } }, 'budget_above_base'],
    ['an unregistered base', { ...CREATE, agentId: 'x-three', base: { agentId: 'action-probe', version: 99 } }, 'base_definition_not_found'],
  ])('refuses %s', async (_name, body, expected) => {
    expect(code(await post('/v1/agent-drafts', body))).toBe(expected);
  });

  it.each([
    ['an upper-case agent id', { ...CREATE, agentId: 'Probe' }],
    ['a bad template', { ...CREATE, template: 'Canal Nuevo' }],
    ['an extra field', { ...CREATE, state: 'launched' }],
  ])('create: %s is a 400', async (_name, body) => {
    const res = await post('/v1/agent-drafts', body);
    expect([res.statusCode, code(res)]).toEqual([400, 'validation_failed']);
  });

  it('each save is a new immutable revision; the reads return the draft with every revision, newest first', async () => {
    const { note: _n, agentId: _a, base: _b, template: _t, channel: _c, ...edits } = CREATE;
    const res = await post(`/v1/agent-drafts/${draftId}/revisions`, { ...edits, instructions: 'Shorter replies.', note: 'más corto' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ draft: Draft }>().draft).toMatchObject({ revision: 2, state: 'draft', updatedBy: 'oidc:felipe' });
    const view = (await get(`/v1/agent-drafts/${draftId}`)).json<{ draft: Draft; revisions: Revision[] }>();
    expect(view.revisions.map((r) => [r.revision, r.definition.instructions, r.note])).toEqual([[2, 'Shorter replies.', 'más corto'], [1, 'Short replies.', 'primer borrador']]);
    expect((await get('/v1/agent-drafts')).json<{ drafts: Draft[] }>().drafts.map((d) => d.draftId)).toEqual([draftId]);
    await expect(platform.pool.query(`update agent_draft_revisions set note = 'x' where draft_id = $1`, [draftId])).rejects.toThrow();
  });

  it('discarding closes the draft for good; a closed draft cannot change; the agent id can start a new draft', async () => {
    expect((await post(`/v1/agent-drafts/${draftId}/discard`, {})).json<{ draft: Draft }>().draft.state).toBe('discarded');
    const { note: _n, agentId: _a, base: _b, template: _t, channel: _c, ...edits } = CREATE;
    expect(code(await post(`/v1/agent-drafts/${draftId}/revisions`, edits))).toBe('agent_draft_closed');
    expect(code(await post(`/v1/agent-drafts/${draftId}/discard`, {}))).toBe('agent_draft_closed');
    expect((await post('/v1/agent-drafts', CREATE)).statusCode).toBe(201);
    expect(code(await post(`/v1/agent-drafts/${randomUUID()}/discard`, {}))).toBe('agent_draft_not_found');
  });
});

describe('variants (ADR-054 revision 2, W2a)', () => {
  const VARIANT = { agentId: 'action-probe', base: { agentId: 'action-probe', version: 1 }, template: 'variant', ...EDITS };

  it('a variant keeps its base agent id, needs a label, and an agent can have several open variants', async () => {
    const a = await post('/v1/agent-drafts', { ...VARIANT, label: 'A · pregunta el uso' });
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json<{ draft: Draft }>().draft).toMatchObject({ agentId: 'action-probe', label: 'A · pregunta el uso', state: 'draft' });
    expect((await post('/v1/agent-drafts', { ...VARIANT, label: 'B · más breve' })).statusCode).toBe(201);
    const dup = await post('/v1/agent-drafts', { ...VARIANT, label: 'A · pregunta el uso' });
    expect([dup.statusCode, code(dup)]).toEqual([409, 'agent_draft_open']);
  });

  it.each([
    ['without a label', { ...VARIANT }],
    ['with another agent id', { ...VARIANT, agentId: 'action-probe-other', label: 'C' }],
  ])('refuses a variant %s', async (_name, body) => {
    expect(code(await post('/v1/agent-drafts', body))).toBe('variant_identity');
  });

  it('a long label is a 400', async () => {
    const res = await post('/v1/agent-drafts', { ...VARIANT, label: 'x'.repeat(61) });
    expect([res.statusCode, code(res)]).toEqual([400, 'validation_failed']);
  });
});
