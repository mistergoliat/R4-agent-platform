import type { CompiledContext, CompiledContextItem } from '@r4/contracts';
import type { ModelRequest } from '@r4/model-gateway';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

/**
 * Renders a provider-neutral ModelRequest into chat-completions messages.
 * The kernel's messages keep their roles; the CompiledContext travels as one
 * JSON document — the same structure the ContextSnapshot recorded, with only
 * default-valued fields left out (empty sections and assertions, NORMAL
 * sensitivity, a zero derivation count). Nothing is summarized, reordered
 * or truncated here.
 */
export function renderMessages(request: ModelRequest): ChatMessage[] {
  const messages: ChatMessage[] = request.messages.map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.content }));
  const json = request.outputContract.kind === 'json';
  if (json) {
    messages.push({ role: 'system', content: `Output: exactly one JSON document matching the "${request.outputContract.name}" JSON Schema below. ${ONE_DOCUMENT_RULE}\n${JSON.stringify(request.outputContract.schema)}` });
  }
  if (request.context) messages.push({ role: 'user', content: `${renderContext(request.context)}${json ? `\n${ONE_DOCUMENT_REMINDER}` : ''}` });
  return messages;
}

/**
 * R4-J4-R6 F-1: with a JSON output contract, deepseek-flash answered turns that needed several reads with two or
 * three concatenated JSON documents, or with one document followed by prose; the strict parser rejects both
 * (ADR-008, no repair). This states the one-document constraint without naming any decision type, so the adapter
 * stays agent-neutral; the reminder closes the user message, right where the model decides.
 */
export const ONE_DOCUMENT_RULE =
  'One answer carries one document, never two or more. When several pieces of information or several steps are needed, return only the first one now; its result arrives in the next turn. Write nothing before or after the document: no prose, no notes, no code fences.';
export const ONE_DOCUMENT_REMINDER = 'Answer with exactly one JSON document and nothing else. If you need several steps, return only the first one.';

export function renderContext(context: CompiledContext): string {
  const sections = Object.fromEntries(Object.entries(context.sections).filter(([, items]) => items.length > 0).map(([name, items]) => [name, items.map(renderItem)]));
  const document = {
    schemaVersion: context.schemaVersion,
    asOf: context.asOf,
    iteration: context.scope.iteration,
    sections,
    ...(context.conflicts.length > 0 ? { conflicts: context.conflicts } : {}),
    ...(Object.keys(context.omissions).length > 0 ? { omissions: context.omissions } : {}),
  };
  return `Structured context (compiled by the platform; authority and freshness per item). Decide the next step.\n${JSON.stringify(document)}`;
}

function renderItem(item: CompiledContextItem): Record<string, unknown> {
  const { provenance, assertions, sensitivity, ...rest } = item;
  const { derivedFromCount, ...source } = provenance;
  return {
    ...rest,
    ...(assertions.length > 0 ? { assertions } : {}),
    ...(sensitivity !== 'NORMAL' ? { sensitivity } : {}),
    provenance: derivedFromCount > 0 ? { ...source, derivedFromCount } : source,
  };
}

/**
 * Conservative size estimate for the physical envelope check (UTF-8 bytes / 3
 * rounds JSON-heavy Spanish or English text up, never down, for common
 * tokenizers). Deliberately not a vendor tokenizer: the adapter only needs to
 * refuse what cannot fit, not to bill.
 */
export function estimateTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + Math.ceil(Buffer.byteLength(m.content, 'utf8') / 3) + 4, 0);
}

/**
 * Extracts the JSON document of a structured answer. Some servers wrap it in
 * a Markdown code fence even when asked not to; that transport difference is
 * removed here. Anything else is left for the platform's strict parser.
 */
export function jsonDocumentOf(content: string | null): unknown {
  if (content === null) return undefined;
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const text = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
