import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import type { QuoteV2Service } from '@r4-adapters/domains';
import type { WriteCapabilityRegistration, WriteExecutionResult } from '@r4/capability-runtime';
import type { Observation } from '@r4/contracts';

/**
 * (ADR-062 O1) desk.opportunity.record@1: Pesín records a sales opportunity in the sales desk (the desk owns the
 * opportunity; R4 Core never knows it). The model gives only the classification, from closed lists; the platform fills
 * the conversation, channel, agent and the quote (number and gross from Quote, never from the model), signs the body
 * and POSTs it to the desk ingest. The desk is idempotent by key; the model gets back only { recorded: true }.
 *
 * (ADR-062, owner 2026-11-25) @2: the model may also say there was no buying intent (intent sin_intencion with a closed
 * reason), and the platform adds what makes an opportunity real: the buying signals of THIS conversation, computed from
 * its recorded observations (never from the model), and an opaque per-contact reference (contactRef) from the verified
 * binding. The desk creates an opportunity only with a signal and an intent; the rest is kept for measurement only.
 */
export const DESK_OPPORTUNITY_CAPABILITY_ID = 'desk.opportunity.record';
export const DESK_OPPORTUNITY_SCOPE = 'desk.opportunity.write';
/** The profile domain of the desk ingest binding (a Sales domain, not a Core one). */
export const DESK_DOMAIN = 'sales-desk';
export const DESK_INGEST_CONTRACT_REF = 'ADR-062 Decisions 2-3 (desk opportunity ingest: HMAC-signed POST, strict body, idempotent by key)';
/** ponytail: process-local cap per conversation (resets on restart); the desk dedups by key anyway. Count durable receipts if abused. */
export const DESK_OPPORTUNITY_MAX_PER_TASK = 5;

export const DESK_TRIGGERS = ['consulta', 'traspaso', 'cotizacion', 'conversacion'] as const;
export const DESK_INTENTS = ['compra', 'cotizacion', 'postventa', 'servicio_tecnico', 'otra'] as const;
export const DESK_SEGMENTS = ['persona', 'empresa', 'mayorista', 'institucional', 'desconocido'] as const;
export const DESK_COMPLEXITIES = ['estandar', 'proyecto'] as const;

/** (@2) Closed lists added by version 2. */
export const DESK_INTENTS_V2 = [...DESK_INTENTS, 'sin_intencion'] as const;
export const DESK_NO_INTENT_REASONS = ['broma', 'spam', 'prueba', 'casual', 'fuera_de_alcance', 'duda_tecnica'] as const;
export const DESK_SIGNALS = ['cotizacion', 'propuesta', 'despacho', 'producto', 'traspaso'] as const;
export type DeskSignal = (typeof DESK_SIGNALS)[number];

export const deskOpportunityInput = z.strictObject({
  trigger: z.enum(DESK_TRIGGERS),
  intent: z.enum(DESK_INTENTS),
  segment: z.enum(DESK_SEGMENTS),
  complexity: z.enum(DESK_COMPLEXITIES),
  productRefs: z.array(z.string().regex(/^[A-Za-z0-9._/-]{1,40}$/)).max(10),
  summary: z.string().trim().min(1).max(500),
});
export type DeskOpportunityInput = z.infer<typeof deskOpportunityInput>;

export const deskOpportunityInputV2 = z.strictObject({
  ...deskOpportunityInput.shape,
  intent: z.enum(DESK_INTENTS_V2),
  /** Required when intent is sin_intencion; otherwise absent or null (checked at execution, with a message). */
  noIntentReason: z.enum(DESK_NO_INTENT_REASONS).nullable().optional(),
});
export type DeskOpportunityInputV2 = z.infer<typeof deskOpportunityInputV2>;

export const deskOpportunityOutput = z.strictObject({ recorded: z.literal(true) });
export type DeskOpportunityOutput = z.infer<typeof deskOpportunityOutput>;

export interface DeskIngestConfig {
  readonly url: string;
  readonly key: string;
}

export interface DeskOpportunityDeps {
  readonly desk: DeskIngestConfig;
  /** The quotes issued in this conversation (sales.quote_v2_issued), latest first. */
  readonly store: { conversationQuotes(taskIds: readonly string[], options: { readonly since: string; readonly limit: number }): Promise<readonly { readonly quoteId: string; readonly quoteNumber: string }[]> };
  /** Quote V2, for the issued quote's gross; null when the profile has no REAL Quote (then no quote is ever found). */
  readonly quotes: Pick<QuoteV2Service, 'getQuote'> | null;
  /** The verified conversation binding (its channel and, for @2, the contact); the profile's channel when there is none. */
  readonly bindings: { bindingByTask(taskId: string): Promise<{ readonly channel: string; readonly recipientRef: string } | null> };
  readonly profileChannel: string;
  /** The channels the desk accepts (its contract); deployment wiring names them, never the pack runtime. */
  readonly channels: readonly string[];
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
}

/** (@2) The task's recorded observations (the public Core store: PostgresObservationStore.listByTask), oldest first. */
export interface TaskObservationReader {
  listByTask(taskId: string): Promise<readonly Pick<Observation, 'source' | 'outcome' | 'payload'>[]>;
}

export interface DeskOpportunityV2Deps extends DeskOpportunityDeps {
  readonly observations: TaskObservationReader;
}

const CONTINUE = 'continue the conversation normally and never mention this record to the customer';
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const PHONE = /(?:\+?56[\s.-]?)?9[\s.-]?\d{4}[\s.-]?\d{4}\b|\d{9,}/;
const RUT = /\b\d{1,2}\.?\d{3}\.?\d{3}-[\dkK]\b/;

/** base64url(HMAC-SHA256(key, "<timestamp>.<raw body>")): what the desk verifies. */
export function deskSignature(key: string, timestamp: string, body: string): string {
  return createHmac('sha256', key).update(`${timestamp}.${body}`).digest('base64url');
}

/** Deterministic: the same conversation, moment, quote and classification always denote one record (a @1 input keeps its @1 key). */
export function deskOpportunityKey(taskId: string, input: DeskOpportunityInput | DeskOpportunityInputV2, quoteNumber: string | null): string {
  const parts = [taskId, input.trigger, quoteNumber ?? '', input.intent, input.segment, input.complexity, input.summary];
  if ('noIntentReason' in input && input.noIntentReason) parts.push(input.noIntentReason);
  return `r4-opp_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 48)}`;
}

/** (@2) Opaque, stable per contact and channel: base64url(HMAC-SHA256(key, "contact|<channel>|<recipientRef>")), 43 chars. */
export function deskContactRef(key: string, channel: string, recipientRef: string): string {
  return createHmac('sha256', key).update(`contact|${channel}|${recipientRef}`).digest('base64url').slice(0, 43);
}

/**
 * (@2) The buying signals of a conversation, from its recorded observations only (deterministic; the model cannot add
 * one): cotizacion = quote.preview read or quote.create applied; propuesta = sales.workspace.update applied with
 * products in the selection; despacho = shipping.quote for a commune; producto = catalog.get_product_context read;
 * traspaso = the record is the handoff's. Ordered as DESK_SIGNALS.
 */
export function deskSignalsOf(observations: readonly Pick<Observation, 'source' | 'outcome' | 'payload'>[], trigger: DeskOpportunityInput['trigger']): DeskSignal[] {
  const read = (id: string) => observations.filter((o) => o.outcome === 'succeeded' && o.source.kind === 'capability' && o.source.capabilityId === id);
  const applied = (id: string) => observations.filter((o) => o.outcome === 'succeeded' && o.source.kind === 'action' && o.source.capabilityId === id);
  const field = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), value);
  const found = new Set<DeskSignal>();
  if (read('quote.preview').length > 0 || applied('quote.create').length > 0) found.add('cotizacion');
  if (applied('sales.workspace.update').some((o) => { const selection = field(o.payload, 'result', 'selection'); return Array.isArray(selection) && selection.length > 0; })) found.add('propuesta');
  if (read('shipping.quote').some((o) => { const commune = field(o.payload, 'destination', 'communeId'); return typeof commune === 'string' && commune !== ''; })) found.add('despacho');
  if (read('catalog.get_product_context').length > 0) found.add('producto');
  if (trigger === 'traspaso') found.add('traspaso');
  return DESK_SIGNALS.filter((s) => found.has(s));
}

/** R4_DESK_INGEST_URL (loopback http, otherwise https with R4_PROD_ALLOW_NETWORK=true) and R4_DESK_INGEST_KEY (≥32 chars). Fails closed. */
export function loadDeskIngestConfig(env: Readonly<Record<string, string | undefined>>, options: { readonly allowNetwork: boolean }): DeskIngestConfig {
  const rawUrl = env.R4_DESK_INGEST_URL?.trim();
  const key = env.R4_DESK_INGEST_KEY?.trim();
  if (!rawUrl || !key) throw new Error('refusing to compose desk.opportunity.record: missing R4_DESK_INGEST_URL or R4_DESK_INGEST_KEY');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('R4_DESK_INGEST_URL is not a URL');
  }
  if (url.search || url.hash || url.username || url.password) throw new Error('R4_DESK_INGEST_URL must not carry credentials, a query or a fragment');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('R4_DESK_INGEST_URL must be http(s)');
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (!loopback && !options.allowNetwork) throw new Error('refusing a non-local R4_DESK_INGEST_URL without R4_PROD_ALLOW_NETWORK=true');
  if (!loopback && url.protocol !== 'https:') throw new Error('a non-local R4_DESK_INGEST_URL must use https');
  if (key.length < 32 || !/^[\x21-\x7e]+$/.test(key)) throw new Error('R4_DESK_INGEST_KEY is not a plausible key (at least 32 printable characters)');
  return { url: url.toString(), key };
}

type Refusal = Extract<WriteExecutionResult<never>, { status: 'rejected' | 'failed' }>;
const rejected = (code: string, message: string): Refusal => ({ status: 'rejected', code, message });
const failed = (code: string, message: string): Refusal => ({ status: 'failed', code, message });

const DESCRIPTION_V1 =
  'Records this conversation as a sales opportunity for the sales team (internal; the customer never sees it). Give only: trigger (consulta = you consulted the team; traspaso = you handed off; cotizacion = you issued a quote; conversacion = the conversation is ending and the customer showed buying intent), intent, segment (empresa = buys with factura/RUT for a company; mayorista = reseller or volume pricing; institucional = school, municipality, public body or tender; desconocido when unclear), complexity (proyecto = equipping a whole gym, studio or facility; otherwise estandar), productRefs (catalog keys seen in this conversation) and a short summary in Spanish without phone numbers, emails or RUT. The platform adds the conversation, channel and quote. The result is only { recorded: true }. If it is refused or fails, continue normally and never mention it to the customer.';
const DESCRIPTION_V2 =
  'Records this conversation for the sales team (internal; the customer never sees it). Give only: trigger (consulta = you consulted the team; traspaso = you are handing off; cotizacion = you issued a quote; conversacion = the conversation is ending), intent (compra, cotizacion, postventa, servicio_tecnico, otra; sin_intencion when there is no real buying intent: a joke, spam, a test, small talk, something outside the store, or a pure technical or training doubt), noIntentReason (only with sin_intencion: broma, spam, prueba, casual, fuera_de_alcance or duda_tecnica), segment (empresa = buys with factura/RUT for a company; mayorista = reseller or volume pricing; institucional = school, municipality, public body or tender; desconocido when unclear), complexity (proyecto = equipping a whole gym, studio or facility; otherwise estandar), productRefs (catalog keys seen in this conversation) and a short summary in Spanish without phone numbers, emails or RUT. Never present a joke or a test as a purchase. The platform adds the conversation, channel, quote and what actually happened in it. The result is only { recorded: true }. If it is refused or fails, continue normally and never mention it to the customer.';

/** desk.opportunity.record@1 (sales-web@21, sales-production@27, the Meta v2 profiles). */
export function deskOpportunityCapability(deps: DeskOpportunityDeps): WriteCapabilityRegistration<DeskOpportunityInput, DeskOpportunityOutput> {
  return deskRecord(deps, 1, deskOpportunityInput, null);
}

/** desk.opportunity.record@2 (sales-web@22, sales-production@28): no-intent classification, signals and contactRef. */
export function deskOpportunityV2Capability(deps: DeskOpportunityV2Deps): WriteCapabilityRegistration<DeskOpportunityInputV2, DeskOpportunityOutput> {
  return deskRecord(deps, 2, deskOpportunityInputV2, deps.observations);
}

function deskRecord<I extends DeskOpportunityInput | DeskOpportunityInputV2>(deps: DeskOpportunityDeps, version: 1 | 2, inputSchema: z.ZodType<I>, observations: TaskObservationReader | null): WriteCapabilityRegistration<I, DeskOpportunityOutput> {
  const recordedKeys = new Map<string, Set<string>>();
  const send = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  return {
    definition: {
      capabilityId: DESK_OPPORTUNITY_CAPABILITY_ID,
      version,
      description: version === 1 ? DESCRIPTION_V1 : DESCRIPTION_V2,
      owner: 'sales',
      riskClass: 'REVERSIBLE_WRITE',
      requiredScopes: [DESK_OPPORTUNITY_SCOPE],
      identityRequirement: 'none',
      confirmationPolicy: 'none',
      approvalPolicy: 'none',
      idempotency: 'key_required',
      retryPolicy: { maxAttempts: 2, initialBackoffMs: 500 },
      timeoutMs: 5_000,
      freshnessTtlMs: null,
      auditLevel: 'full',
    },
    recovery: 'idempotent_replay',
    input: inputSchema,
    output: deskOpportunityOutput,
    async execute(given, context) {
      const input: DeskOpportunityInputV2 = given;
      const { taskId, agentId, agentVersion } = context.execution;
      if (input.intent === 'sin_intencion' && !input.noIntentReason) return rejected('no_intent_reason_required', `with intent sin_intencion, give noIntentReason (broma, spam, prueba, casual, fuera_de_alcance or duda_tecnica): ${CONTINUE}`);
      if (input.intent !== 'sin_intencion' && input.noIntentReason) return rejected('no_intent_reason_not_allowed', `noIntentReason goes only with intent sin_intencion: ${CONTINUE}`);
      if (EMAIL.test(input.summary) || PHONE.test(input.summary) || RUT.test(input.summary)) {
        return rejected('summary_has_contact_data', `the summary must not contain phone numbers, emails or RUT: write it again without them (${CONTINUE})`);
      }
      const binding = await deps.bindings.bindingByTask(taskId);
      const channel = binding?.channel ?? deps.profileChannel;
      if (!deps.channels.includes(channel)) return failed('channel_unsupported', `this channel does not record opportunities: ${CONTINUE}`);
      const latest = deps.quotes ? (await deps.store.conversationQuotes([taskId], { since: '1970-01-01T00:00:00Z', limit: 1 }))[0] : undefined;
      let quote: { quoteNumber: string; grossClp: number } | null = null;
      if (latest && /^[A-Za-z0-9-]{3,40}$/.test(latest.quoteNumber)) {
        try {
          const gross = (await deps.quotes!.getQuote(latest.quoteId, { signal: context.signal, correlationId: context.execution.correlationId })).totals.gross;
          if (Number.isSafeInteger(gross) && gross >= 0) quote = { quoteNumber: latest.quoteNumber, grossClp: gross };
        } catch {
          return failed('quote_unreadable', `the issued quote could not be read, nothing was recorded: ${CONTINUE}`);
        }
      }
      const idempotencyKey = deskOpportunityKey(taskId, input, quote?.quoteNumber ?? null);
      const keys = recordedKeys.get(taskId) ?? new Set<string>();
      if (!keys.has(idempotencyKey) && keys.size >= DESK_OPPORTUNITY_MAX_PER_TASK) return rejected('record_limit', `this conversation already has ${DESK_OPPORTUNITY_MAX_PER_TASK} records; do not record again: ${CONTINUE}`);
      const classification = { intent: input.intent, segment: input.segment, complexity: input.complexity, productRefs: input.productRefs, summary: input.summary };
      const agent = { agentId, agentVersion };
      const body = JSON.stringify(
        observations === null
          ? { idempotencyKey, taskId, channel, trigger: input.trigger, classification, quote, agent }
          : {
              version: 2,
              idempotencyKey,
              taskId,
              channel,
              trigger: input.trigger,
              classification: { ...classification, noIntentReason: input.noIntentReason ?? null },
              quote,
              // ponytail: reads every observation of the task per record (at most 5 per conversation); filter in SQL if tasks grow large.
              signals: deskSignalsOf(await observations.listByTask(taskId), input.trigger),
              // Never the raw recipient: an opaque reference the desk can only compare.
              contactRef: binding ? deskContactRef(deps.desk.key, binding.channel, binding.recipientRef) : null,
              agent,
            },
      );
      if (Buffer.byteLength(body) > 8_000) return rejected('record_too_large', `the record is too large: shorten the summary (${CONTINUE})`);
      const timestamp = String(Math.floor((deps.now?.() ?? new Date()).getTime() / 1000));
      const remember = () => {
        keys.add(idempotencyKey);
        recordedKeys.set(taskId, keys);
        if (recordedKeys.size > 10_000) recordedKeys.delete(recordedKeys.keys().next().value!);
      };
      let response: Response;
      try {
        response = await send(deps.desk.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-r4-timestamp': timestamp, 'x-r4-signature': deskSignature(deps.desk.key, timestamp, body) },
          body,
          signal: context.signal,
        });
      } catch {
        // Timeout or a broken connection: maybe recorded. The same key is retried, never a second record.
        remember();
        return { status: 'unknown', message: `the desk did not confirm the record; it is retried with the same key: ${CONTINUE}` };
      }
      if (response.status === 200) {
        remember();
        const reply = (await response.json().catch(() => null)) as { opportunityId?: unknown } | null;
        return { status: 'applied', result: { recorded: true }, ...(typeof reply?.opportunityId === 'string' ? { resourceRef: `desk-opportunity:${reply.opportunityId}` } : {}), externalOperationRef: idempotencyKey, replayed: false };
      }
      const code = ((await response.json().catch(() => null)) as { error?: { code?: unknown } } | null)?.error?.code;
      if (response.status === 400) return failed(`desk_refused_${typeof code === 'string' ? code : 'invalid'}`, `the desk refused the record, nothing was recorded: ${CONTINUE}`);
      if (response.status === 401) return failed('desk_unauthorized', `the desk refused the signature, nothing was recorded: ${CONTINUE}`);
      if (response.status < 500 || code === 'not_applied') return failed('desk_failed', `the desk could not record it (${response.status}), nothing was recorded: ${CONTINUE}`);
      remember();
      return { status: 'unknown', message: `the desk did not confirm the record (${response.status}); it is retried with the same key: ${CONTINUE}` };
    },
  };
}
