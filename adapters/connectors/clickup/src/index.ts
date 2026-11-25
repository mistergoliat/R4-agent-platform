import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * ClickUp connector (ADR-061 D6, ADR-058 D13). The graph curator asks its questions as ClickUp tasks in ONE configured
 * list and reads the answers back. Writing to ClickUp is code with its guarantees, not a declarative connector:
 *   - every write touches only tasks of the configured list that carry an R4 question tag (`r4-q-<id>`);
 *   - creating a task is idempotent per question: the tag is searched (open and closed) before creating, so a retried
 *     or timed-out create never leaves two tasks for one question (ClickUp documents no idempotency key);
 *   - failures are classified (ClickUpError.code) for the caller's retry and reconciliation;
 *   - incoming webhooks are verified (X-Signature = hex HMAC-SHA256 of the raw body with the webhook secret).
 *
 * ClickUp API v2, verified on developer.clickup.com on 2026-11-25:
 *   auth `Authorization: pk_…` (no Bearer) · POST /list/{id}/task (name, markdown_content, tags, priority 1–4,
 *   assignees, due_date ms) · GET /list/{id}/task (tags[], include_closed, page from 0, 100 per page, last_page)
 *   · POST /task/{id}/comment (comment_text, notify_all) · POST /task/{id}/field/{field_id} {value} (a dropdown takes
 *   the option UUID) · GET /list/{id} statuses[] with type "closed" · webhook header X-Signature · 429 with
 *   X-RateLimit-Reset (unix seconds) · 100 requests/minute per token below Business Plus.
 * Not on the pages verified: closing with PUT /task/{id} {status} (the standard update), GET /task/{id} shape. Their use
 * is covered by tests against recorded shapes and must be checked on the first real run.
 */
export const CLICKUP_DEFAULT_BASE_URL = 'https://api.clickup.com/api/v2';
export type QuestionPriority = 'urgent' | 'high' | 'normal';
const PRIORITY: Readonly<Record<QuestionPriority, number>> = { urgent: 1, high: 2, normal: 3 };
const TAG_PREFIX = 'r4-q-';
const TASK_ID = /^[A-Za-z0-9_-]{3,40}$/;

export interface ClickUpConfig {
  readonly token: string;
  readonly listId: string;
  /** The «Respuesta» custom field (dropdown Sí/No or text). */
  readonly answerFieldId: string | null;
  /** The PM the questions are assigned to (ClickUp user id). */
  readonly assigneeId: number | null;
  readonly webhookSecret: string | null;
  readonly baseUrl: string;
}

const isLoopback = (u: URL) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname);

/** From the console vault (~/.config/r4/secrets/connectors/clickup.env) plus the list settings. Says exactly what is missing. */
export function loadClickUpConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean }): ClickUpConfig {
  const v = (name: string) => env[name]?.trim() ?? '';
  const problems: string[] = [];
  const token = v('R4_CLICKUP_API_TOKEN');
  const listId = v('R4_CLICKUP_LIST_ID');
  const assignee = v('R4_CLICKUP_ASSIGNEE_ID');
  const answerFieldId = v('R4_CLICKUP_ANSWER_FIELD_ID');
  if (!/^pk_[0-9]{3,20}_[A-Za-z0-9]{20,64}$/.test(token)) problems.push('R4_CLICKUP_API_TOKEN is missing or is not a personal token (pk_…)');
  if (!/^[0-9]{3,20}$/.test(listId)) problems.push('R4_CLICKUP_LIST_ID is missing (the numeric id of the «Curador del grafo» list)');
  if (assignee && !/^[0-9]{1,20}$/.test(assignee)) problems.push('R4_CLICKUP_ASSIGNEE_ID must be the numeric ClickUp user id');
  if (answerFieldId && !/^[0-9a-f-]{36}$/i.test(answerFieldId)) problems.push('R4_CLICKUP_ANSWER_FIELD_ID must be the field UUID');
  let base: URL | null = null;
  try {
    base = new URL(v('R4_CLICKUP_BASE_URL') || CLICKUP_DEFAULT_BASE_URL);
  } catch {
    problems.push('R4_CLICKUP_BASE_URL is not a URL');
  }
  if (base && !isLoopback(base) && !options.allowNetwork) problems.push('a non-local ClickUp URL requires R4_PROD_ALLOW_NETWORK=true');
  if (base && !isLoopback(base) && base.protocol !== 'https:') problems.push('a non-local ClickUp URL must use https');
  if (problems.length > 0) throw new Error(`refusing the ClickUp connector: ${problems.join('; ')}`);
  return Object.freeze({ token, listId, answerFieldId: answerFieldId || null, assigneeId: assignee ? Number(assignee) : null, webhookSecret: v('R4_CLICKUP_WEBHOOK_SECRET') || null, baseUrl: base!.toString().replace(/\/+$/, '') });
}

export type ClickUpErrorCode = 'rate_limited' | 'auth' | 'not_found' | 'invalid' | 'foreign_task' | 'unavailable' | 'unknown' | 'not_configured';

/** A classified failure. `unknown` = the write may have happened (a create is still deduplicated by its tag). */
export class ClickUpError extends Error {
  readonly code: ClickUpErrorCode;
  readonly retryAfterMs: number | null;
  constructor(code: ClickUpErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ClickUpError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface QuestionTask {
  readonly taskId: string;
  readonly url: string;
  readonly questionId: string;
  readonly status: string;
  readonly closed: boolean;
  readonly priority: QuestionPriority | null;
  /** The «Respuesta» field value as ClickUp returns it (option UUID, or text), or null. */
  readonly answer: string | null;
  readonly dateUpdated: string | null;
}

export type ClickUpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A JSON scalar as text ('' for anything else). */
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

/** The tag that identifies an R4 question in ClickUp: lowercase, [a-z0-9-], at most 60 characters. */
export function questionTag(questionId: string): string {
  const id = questionId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!id) throw new ClickUpError('invalid', 'the question id is empty');
  return `${TAG_PREFIX}${id}`.slice(0, 60);
}

const PRIORITY_NAME: Readonly<Record<string, QuestionPriority>> = { '1': 'urgent', '2': 'high', '3': 'normal', urgent: 'urgent', high: 'high', normal: 'normal' };

export class ClickUpConnector {
  readonly #c: ClickUpConfig;
  readonly #fetch: ClickUpFetch;
  readonly #timeoutMs: number;
  #closedStatus: string | null = null;

  constructor(config: ClickUpConfig, options: { readonly fetch?: ClickUpFetch; readonly timeoutMs?: number } = {}) {
    this.#c = config;
    this.#fetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** One task per question, in the configured list. Returns the existing one (created=false) if the question was already asked. */
  async createQuestionTask(input: { readonly questionId: string; readonly title: string; readonly markdown: string; readonly priority: QuestionPriority; readonly dueDate?: Date }): Promise<{ taskId: string; url: string; created: boolean }> {
    const tag = questionTag(input.questionId);
    const existing = await this.#findByTag(tag);
    if (existing) return { taskId: existing.taskId, url: existing.url, created: false };
    const title = input.title.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!title) throw new ClickUpError('invalid', 'the task title is empty');
    const body: Json = { name: title, markdown_content: input.markdown.slice(0, 20_000), tags: [tag], priority: PRIORITY[input.priority], notify_all: false };
    if (this.#c.assigneeId !== null) body.assignees = [this.#c.assigneeId];
    if (input.dueDate) body.due_date = input.dueDate.getTime();
    const task = await this.#call('POST', `/list/${this.#c.listId}/task`, body);
    const id = isObject(task) && typeof task.id === 'string' && TASK_ID.test(task.id) ? task.id : null;
    if (!id) throw new ClickUpError('unknown', 'ClickUp accepted the task without an id');
    return { taskId: id, url: isObject(task) && typeof task.url === 'string' ? task.url : '', created: true };
  }

  async commentTask(taskId: string, text: string): Promise<void> {
    await this.#own(taskId);
    await this.#call('POST', `/task/${taskId}/comment`, { comment_text: text.slice(0, 10_000), notify_all: false });
  }

  async setAnswerField(taskId: string, value: string): Promise<void> {
    if (!this.#c.answerFieldId) throw new ClickUpError('not_configured', 'R4_CLICKUP_ANSWER_FIELD_ID is not set');
    await this.#own(taskId);
    await this.#call('POST', `/task/${taskId}/field/${this.#c.answerFieldId}`, { value });
  }

  /** Closes the task with the list's closed status, after an optional closing comment. */
  async closeTask(taskId: string, note?: string): Promise<void> {
    await this.#own(taskId);
    if (note) await this.#call('POST', `/task/${taskId}/comment`, { comment_text: note.slice(0, 10_000), notify_all: false });
    await this.#call('PUT', `/task/${taskId}`, { status: await this.#closed() });
  }

  /** Every R4 question task of the list (pages of 100 until last_page). */
  async readList(options: { readonly includeClosed?: boolean } = {}): Promise<QuestionTask[]> {
    const out: QuestionTask[] = [];
    for (let page = 0; page < 50; page += 1) {
      const res = await this.#call('GET', `/list/${this.#c.listId}/task?page=${page}&include_closed=${options.includeClosed ? 'true' : 'false'}&subtasks=false`);
      const tasks: unknown[] = isObject(res) && Array.isArray(res.tasks) ? res.tasks : [];
      for (const t of tasks) {
        const q = this.#question(t);
        if (q) out.push(q);
      }
      if (!isObject(res) || res.last_page !== false || tasks.length === 0) break;
    }
    return out;
  }

  /**
   * The comments of an R4 question task, oldest first, optionally only those after `sinceMs`. ClickUp returns the 25
   * most recent and pages backwards with `start` (a comment's date) and `start_id` (its id); at most 10 pages.
   */
  async readComments(taskId: string, options: { readonly sinceMs?: number } = {}): Promise<{ commentId: string; userId: number | null; text: string; dateMs: number }[]> {
    await this.#own(taskId);
    const out: { commentId: string; userId: number | null; text: string; dateMs: number }[] = [];
    let cursor = '';
    for (let page = 0; page < 10; page += 1) {
      const res = await this.#call('GET', `/task/${taskId}/comment${cursor}`);
      const comments: unknown[] = isObject(res) && Array.isArray(res.comments) ? res.comments : [];
      let oldest: { id: string; date: number } | null = null;
      let reachedSince = false;
      for (const c of comments) {
        if (!isObject(c)) continue;
        const id = str(c.id);
        const date = Number(str(c.date));
        if (!id || !Number.isFinite(date)) continue;
        if (!oldest || date < oldest.date) oldest = { id, date };
        if (options.sinceMs !== undefined && date <= options.sinceMs) {
          reachedSince = true;
          continue;
        }
        const user = isObject(c.user) ? Number(str(c.user.id)) : NaN;
        out.push({ commentId: id, userId: Number.isFinite(user) ? user : null, text: str(c.comment_text), dateMs: date });
      }
      if (reachedSince || comments.length < 25 || !oldest) break;
      cursor = `?start=${oldest.date}&start_id=${encodeURIComponent(oldest.id)}`;
    }
    return out.sort((a, b) => a.dateMs - b.dateMs);
  }

  /**
   * The options of the «Respuesta» dropdown: id (the UUID that setAnswerField takes), name and orderindex. A task read
   * may report a dropdown's value as the option id or as its orderindex: match either. GET /list/{id}/field is the
   * documented «Get List Custom Fields»; its exact shape is checked on the first real run.
   */
  async readAnswerOptions(): Promise<{ id: string; name: string; orderindex: number | null }[]> {
    if (!this.#c.answerFieldId) throw new ClickUpError('not_configured', 'R4_CLICKUP_ANSWER_FIELD_ID is not set');
    const res = await this.#call('GET', `/list/${this.#c.listId}/field`);
    const fields: unknown[] = isObject(res) && Array.isArray(res.fields) ? res.fields : [];
    const field: unknown = fields.find((f) => isObject(f) && f.id === this.#c.answerFieldId);
    const config: unknown = isObject(field) ? field.type_config : null;
    const options: unknown[] = isObject(config) && Array.isArray(config.options) ? config.options : [];
    return options.flatMap((o) => (isObject(o) && str(o.id) ? [{ id: str(o.id), name: str(o.name), orderindex: Number.isFinite(Number(str(o.orderindex))) && str(o.orderindex) !== '' ? Number(str(o.orderindex)) : null }] : []));
  }

  /** X-Signature of a webhook delivery: hex HMAC-SHA256 of the raw body with the webhook secret. Fails closed. */
  verifyWebhook(rawBody: string, signature: string | undefined): boolean {
    if (!this.#c.webhookSecret || !signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
    const expected = createHmac('sha256', this.#c.webhookSecret).update(rawBody, 'utf8').digest();
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  #question(t: unknown): QuestionTask | null {
    if (!isObject(t) || typeof t.id !== 'string' || !TASK_ID.test(t.id)) return null;
    const tags = Array.isArray(t.tags) ? t.tags.map((x) => (isObject(x) && typeof x.name === 'string' ? x.name : '')) : [];
    const tag = tags.find((n) => n.startsWith(TAG_PREFIX));
    if (!tag) return null;
    const status = isObject(t.status) ? t.status : {};
    const priority = isObject(t.priority) ? PRIORITY_NAME[str(t.priority.id) || str(t.priority.priority)] ?? null : null;
    const fields: unknown[] = Array.isArray(t.custom_fields) ? t.custom_fields : [];
    const field: unknown = this.#c.answerFieldId ? fields.find((f) => isObject(f) && f.id === this.#c.answerFieldId) : undefined;
    const answer = isObject(field) && str(field.value) !== '' ? str(field.value) : null;
    return {
      taskId: t.id,
      url: typeof t.url === 'string' ? t.url : '',
      questionId: tag.slice(TAG_PREFIX.length),
      status: typeof status.status === 'string' ? status.status : '',
      closed: status.type === 'closed' || status.type === 'done',
      priority,
      answer,
      dateUpdated: typeof t.date_updated === 'string' && /^\d{10,14}$/.test(t.date_updated) ? new Date(Number(t.date_updated)).toISOString() : null,
    };
  }

  async #findByTag(tag: string): Promise<QuestionTask | null> {
    const res = await this.#call('GET', `/list/${this.#c.listId}/task?tags%5B%5D=${encodeURIComponent(tag)}&include_closed=true&subtasks=false`);
    const tasks: unknown[] = isObject(res) && Array.isArray(res.tasks) ? res.tasks : [];
    for (const t of tasks) {
      const q = this.#question(t);
      if (q && `${TAG_PREFIX}${q.questionId}` === tag) return q;
    }
    return null;
  }

  /** Writes only touch R4 question tasks of the configured list. */
  async #own(taskId: string): Promise<void> {
    if (!TASK_ID.test(taskId)) throw new ClickUpError('invalid', 'malformed task id');
    const t = await this.#call('GET', `/task/${taskId}`);
    const list = isObject(t) && isObject(t.list) ? str(t.list.id) : '';
    if (list !== this.#c.listId || !this.#question(t)) throw new ClickUpError('foreign_task', 'the task is not an R4 question of the configured list');
  }

  async #closed(): Promise<string> {
    if (this.#closedStatus) return this.#closedStatus;
    const list = await this.#call('GET', `/list/${this.#c.listId}`);
    const statuses: unknown[] = isObject(list) && Array.isArray(list.statuses) ? list.statuses : [];
    const closed: unknown = statuses.find((s) => isObject(s) && s.type === 'closed');
    if (!isObject(closed) || typeof closed.status !== 'string') throw new ClickUpError('invalid', 'the list has no closed status');
    this.#closedStatus = closed.status;
    return closed.status;
  }

  async #call(method: 'GET' | 'POST' | 'PUT', path: string, body?: Json): Promise<unknown> {
    let res: Awaited<ReturnType<ClickUpFetch>>;
    let raw: string;
    try {
      res = await this.#fetch(`${this.#c.baseUrl}${path}`, {
        method,
        headers: { authorization: this.#c.token, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      raw = await res.text();
    } catch {
      // A write that timed out may have happened: the caller retries; a create is deduplicated by its tag.
      throw new ClickUpError(method === 'GET' ? 'unavailable' : 'unknown', `ClickUp did not answer (${method})`);
    }
    if (res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      throw new ClickUpError('rate_limited', 'ClickUp rate limit', Number.isFinite(reset) && reset > 0 ? Math.max(0, Math.min(reset * 1000 - Date.now(), 120_000)) : 60_000);
    }
    if (res.status === 401) throw new ClickUpError('auth', 'ClickUp refused the token');
    if (res.status === 403) throw new ClickUpError('auth', 'the token has no access to this list or task');
    if (res.status === 404) throw new ClickUpError('not_found', 'ClickUp: not found');
    if (res.status >= 400 && res.status < 500) throw new ClickUpError('invalid', `ClickUp refused the request (${res.status})`);
    if (res.status >= 500) throw new ClickUpError(method === 'GET' ? 'unavailable' : 'unknown', `ClickUp error ${res.status}`);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      throw new ClickUpError('unknown', 'ClickUp answered something that is not JSON');
    }
  }
}
