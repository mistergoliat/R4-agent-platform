import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ClickUpConnector, ClickUpError, loadClickUpConfig, questionTag, type ClickUpFetch } from '@r4-adapters/clickup';

/** ADR-061 D6 / ADR-058 D13: the ClickUp connector of the graph curator — one task per question, only in its list. */
const env = { R4_CLICKUP_API_TOKEN: 'pk_1234567_ABCDEFGHIJKLMNOPQRSTUVWX12345678', R4_CLICKUP_LIST_ID: '901100', R4_CLICKUP_ASSIGNEE_ID: '42', R4_CLICKUP_ANSWER_FIELD_ID: '0a52c486-5f05-403b-b4fd-c512ff05131c', R4_CLICKUP_WEBHOOK_SECRET: 'whsec', R4_CLICKUP_BASE_URL: 'http://127.0.0.1:9/api/v2' };
const config = loadClickUpConfig(env, { allowNetwork: false });

type Call = { method: string; url: string; auth: string; body: unknown };
function fake(routes: Array<(c: Call) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined>) {
  const calls: Call[] = [];
  const fetch: ClickUpFetch = (url, init) => {
    const call = { method: init.method, url: url.replace('http://127.0.0.1:9/api/v2', ''), auth: init.headers.authorization ?? '', body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const r = routes.map((f) => f(call)).find(Boolean) ?? { status: 404 };
    return Promise.resolve({ status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: () => Promise.resolve(r.body === undefined ? '' : JSON.stringify(r.body)) });
  };
  return { fetch, calls };
}
const task = (id: string, tag: string, extra: Record<string, unknown> = {}) => ({ id, url: `https://app.clickup.com/t/${id}`, list: { id: '901100' }, tags: [{ name: tag }], status: { status: 'to do', type: 'open' }, priority: { id: '2' }, date_updated: '1764100000000', custom_fields: [], ...extra });

describe('ClickUp configuration', () => {
  it('needs a personal token and the list; refuses the real API without the network opt-in', () => {
    expect(config).toMatchObject({ listId: '901100', assigneeId: 42, webhookSecret: 'whsec' });
    expect(() => loadClickUpConfig({ ...env, R4_CLICKUP_API_TOKEN: 'abc' }, { allowNetwork: false })).toThrow(/pk_/);
    expect(() => loadClickUpConfig({ ...env, R4_CLICKUP_LIST_ID: '' }, { allowNetwork: false })).toThrow(/R4_CLICKUP_LIST_ID is missing/);
    expect(() => loadClickUpConfig({ ...env, R4_CLICKUP_BASE_URL: '' }, { allowNetwork: false })).toThrow(/R4_PROD_ALLOW_NETWORK/);
    expect(questionTag('Prop:ABC_12')).toBe('r4-q-prop-abc-12');
  });
});

describe('ClickUp connector', () => {
  it('creates one task per question with tag, priority and assignee; asking again returns the same task', async () => {
    const created: unknown[] = [];
    const { fetch, calls } = fake([
      (c) => (c.method === 'GET' && c.url.startsWith('/list/901100/task?tags') ? { status: 200, body: { tasks: created } } : undefined),
      (c) => {
        if (c.method !== 'POST' || c.url !== '/list/901100/task') return undefined;
        const t = task('86abc', 'r4-q-p1');
        created.push(t);
        return { status: 200, body: t };
      },
    ]);
    const cu = new ClickUpConnector(config, { fetch });
    const first = await cu.createQuestionTask({ questionId: 'p1', title: '  ¿El landmine Delta entra en el rack Alpha?  ', markdown: '**Pregunta**', priority: 'urgent', dueDate: new Date(1764700000000) });
    expect(first).toEqual({ taskId: '86abc', url: 'https://app.clickup.com/t/86abc', created: true });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.auth).toBe(env.R4_CLICKUP_API_TOKEN);
    expect(post.body).toEqual({ name: '¿El landmine Delta entra en el rack Alpha?', markdown_content: '**Pregunta**', tags: ['r4-q-p1'], priority: 1, notify_all: false, assignees: [42], due_date: 1764700000000 });
    expect(calls[0]!.url).toContain('include_closed=true');
    expect(await cu.createQuestionTask({ questionId: 'p1', title: 'otra vez', markdown: '', priority: 'normal' })).toEqual({ taskId: '86abc', url: 'https://app.clickup.com/t/86abc', created: false });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('writes only to R4 question tasks of its list: a foreign task is refused before any write', async () => {
    const { fetch, calls } = fake([
      (c) => (c.url === '/task/mine1' ? { status: 200, body: task('mine1', 'r4-q-p2') } : undefined),
      (c) => (c.url === '/task/other' ? { status: 200, body: task('other', 'r4-q-p3', { list: { id: '555' } }) } : undefined),
      (c) => (c.url === '/task/notag' ? { status: 200, body: { ...task('notag', 'x'), tags: [{ name: 'bug' }] } } : undefined),
      (c) => (c.method === 'POST' && c.url.endsWith('/comment') ? { status: 200, body: { id: 1 } } : undefined),
      (c) => (c.method === 'POST' && c.url.includes('/field/') ? { status: 200, body: {} } : undefined),
      (c) => (c.url === '/list/901100' ? { status: 200, body: { statuses: [{ status: 'to do', type: 'open' }, { status: 'complete', type: 'closed' }] } } : undefined),
      (c) => (c.method === 'PUT' ? { status: 200, body: task('mine1', 'r4-q-p2') } : undefined),
    ]);
    const cu = new ClickUpConnector(config, { fetch });
    await cu.commentTask('mine1', 'Gracias, entra en la próxima versión.');
    await cu.setAnswerField('mine1', 'opt-uuid');
    await cu.closeTask('mine1', 'Listo');
    expect(calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/task/mine1/comment', { comment_text: 'Gracias, entra en la próxima versión.', notify_all: false }],
      ['POST', '/task/mine1/field/0a52c486-5f05-403b-b4fd-c512ff05131c', { value: 'opt-uuid' }],
      ['POST', '/task/mine1/comment', { comment_text: 'Listo', notify_all: false }],
      ['PUT', '/task/mine1', { status: 'complete' }],
    ]);
    for (const id of ['other', 'notag']) await expect(cu.commentTask(id, 'x')).rejects.toMatchObject({ code: 'foreign_task' });
    await expect(cu.commentTask('../../team', 'x')).rejects.toMatchObject({ code: 'invalid' });
  });

  it('reads the R4 questions of the list, page by page, with their answer and priority', async () => {
    const field = { id: '0a52c486-5f05-403b-b4fd-c512ff05131c', value: 'opt-si' };
    const { fetch } = fake([
      (c) => (c.url.includes('page=0') ? { status: 200, body: { tasks: [task('aa1', 'r4-q-p1', { custom_fields: [field] }), { id: 'z9', tags: [], status: {} }], last_page: false } } : undefined),
      (c) => (c.url.includes('page=1') ? { status: 200, body: { tasks: [task('aa2', 'r4-q-p2', { status: { status: 'complete', type: 'closed' }, priority: { id: '1' } })], last_page: true } } : undefined),
    ]);
    const tasks = await new ClickUpConnector(config, { fetch }).readList({ includeClosed: true });
    expect(tasks.map((t) => [t.taskId, t.questionId, t.answer, t.closed, t.priority])).toEqual([['aa1', 'p1', 'opt-si', false, 'high'], ['aa2', 'p2', null, true, 'urgent']]);
  });

  it('classifies failures: rate limit with its wait, refused token, a write that may have happened', async () => {
    const reset = Math.floor(Date.now() / 1000) + 30;
    const limited = new ClickUpConnector(config, { fetch: fake([() => ({ status: 429, headers: { 'x-ratelimit-reset': String(reset) } })]).fetch });
    const e = await limited.readList().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ClickUpError);
    expect((e as ClickUpError).code).toBe('rate_limited');
    expect((e as ClickUpError).retryAfterMs).toBeGreaterThan(20_000);
    await expect(new ClickUpConnector(config, { fetch: fake([() => ({ status: 401 })]).fetch }).readList()).rejects.toMatchObject({ code: 'auth' });
    const timeout: ClickUpFetch = (_u, init) => (init.method === 'GET' ? Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve('{"tasks":[]}') }) : Promise.reject(new Error('reset')));
    await expect(new ClickUpConnector(config, { fetch: timeout }).createQuestionTask({ questionId: 'p9', title: 't', markdown: '', priority: 'high' })).rejects.toMatchObject({ code: 'unknown' });
  });

  it('verifies webhook signatures on the raw body, failing closed', () => {
    const cu = new ClickUpConnector(config, { fetch: fake([]).fetch });
    const body = '{"event":"taskUpdated","task_id":"86abc","webhook_id":"w1"}';
    const sig = createHmac('sha256', 'whsec').update(body).digest('hex');
    expect(cu.verifyWebhook(body, sig)).toBe(true);
    expect(cu.verifyWebhook(`${body} `, sig)).toBe(false);
    expect(cu.verifyWebhook(body, undefined)).toBe(false);
    expect(new ClickUpConnector({ ...config, webhookSecret: null }, { fetch: fake([]).fetch }).verifyWebhook(body, sig)).toBe(false);
  });
});
