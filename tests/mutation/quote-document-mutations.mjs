// (Quote PDF delivery, sales-production@18, Core 0015) Mutation checks: each mutation removes one guarantee of the quote
// document delivery (only @18 sends it, only the owner's verified bytes, once per quote, to the conversation's contact,
// never a bare caption, nothing sent when the upload fails, bytes purged once settled) and EVERY test listed for it must
// FAIL (each test is run alone, by name). Sources are restored byte for byte. The tests use the local PostgreSQL.
//
//   npm run test:mutation:quote-document
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const ADAPTER_UT = { project: 'unit', file: 'tests/unit/live-ops/whatsapp-document.test.ts' };
const NOTICE_IT = { project: 'integration', file: 'tests/integration/platform-notice-document.test.ts' };
const SALES_IT = { project: 'integration', file: 'tests/integration/sales-quote-document.test.ts' };
const CONTRACT = { project: 'contract', file: 'tests/contract/sales-profile-v18.test.ts' };
const ADAPTER = 'adapters/channels/whatsapp-cloud/src/outbound.ts';
const OUTBOUND = 'packages/live-ops/src/outbound.ts';
const STORE = 'packages/persistence-postgres/src/production-store.ts';
const SETTLE = 'agents/sales/src/capabilities/quote-v2.ts';
const DOC = 'agents/sales/src/capabilities/quote-document.ts';
const SALES = 'agents/sales/src/production/composition.ts';

const MUTATIONS = [
  {
    name: 'QD-M1 every Quote-writing profile sends the document (not only @18)',
    edits: [{ file: SALES, from: 'documents: SALES_QUOTE_DOCUMENT_PROFILES.has(profileLabel(profile)) ? quoteDocumentDelivery(options.store, options.logger) : null', to: 'documents: quoteDocumentDelivery(options.store, options.logger)' }],
    tests: [[SALES_IT, '@17, the deployed profile, sends no document']],
  },
  {
    name: 'QD-M2 the settlement never queues the verified document',
    edits: [{ file: SETTLE, from: '  if (verifiedBytes && options.documents) {', to: '  if (verifiedBytes && options.documents && false) {' }],
    tests: [[SALES_IT, 'one issuance sends exactly one document']],
  },
  {
    name: 'QD-M3 the store accepts bytes that do not match their SHA-256',
    edits: [{ file: STORE, from: "if (createHash('sha256').update(document.bytes).digest('hex') !== document.sha256) throw new PlatformError('validation', 'document_sha256_mismatch'", to: "if (false) throw new PlatformError('validation', 'document_sha256_mismatch'" }],
    tests: [[NOTICE_IT, 'refuses bytes that do not match their SHA-256']],
  },
  {
    name: 'QD-M4 a replay of the notice key ignores the document (another file replays)',
    edits: [{ file: STORE, from: " || (existingDocument?.sha256 ?? null) !== (document?.sha256 ?? null)) throw", to: ') throw' }],
    tests: [[NOTICE_IT, 'refuses bytes that do not match their SHA-256']],
  },
  {
    name: 'QD-M5 a pending document whose bytes are gone is sent as a bare caption',
    edits: [{ file: STORE, from: '      if (staged && staged.bytes === null) {', to: '      if (false) {' }],
    tests: [[NOTICE_IT, 'a pending document without its bytes is cancelled']],
  },
  {
    name: 'QD-M6 the staged bytes are never purged',
    edits: [{ file: OUTBOUND, from: '    await this.#o.store.purgeSettledDocuments(50);\n', to: '' }],
    tests: [[NOTICE_IT, 'purges the bytes once settled']],
  },
  {
    name: 'QD-M7 the delivery owner submits staged bytes that no longer match their SHA-256',
    edits: [{ file: OUTBOUND, from: "    } else if (document && createHash('sha256').update(document.bytes).digest('hex') !== document.sha256) {", to: '    } else if (false) {' }],
    tests: [[NOTICE_IT, 'staged bytes that no longer match their SHA-256']],
  },
  {
    name: 'QD-M8 a failed upload still sends the message (the caption alone)',
    edits: [{ file: ADAPTER, from: "      if (typeof media !== 'string') return result(media);\n", to: '' }],
    tests: [[ADAPTER_UT, 'an upload failure'], [ADAPTER_UT, 'an upload timeout sends no message']],
  },
  {
    name: 'QD-M9 an upload failure is classified unknown (never retried, the document is lost)',
    edits: [{ file: ADAPTER, from: "    const notSent = (errorClass: string, httpStatus: number | null, errorCode: string | null, retryAfterMs: number | null = null) => ({ outcome: 'not_sent' as const,", to: "    const notSent = (errorClass: string, httpStatus: number | null, errorCode: string | null, retryAfterMs: number | null = null) => ({ outcome: 'unknown' as const," }],
    tests: [[ADAPTER_UT, 'an upload timeout sends no message'], [NOTICE_IT, 'a failed upload is retried as not sent']],
  },
  {
    name: 'QD-M10 the notice key is not the quote (a repeated settlement would send a second document)',
    edits: [{ file: DOC, from: 'export const quoteDocumentNoticeKey = (quoteId: string) => `sales.quote-document:${quoteId.toLowerCase()}`;', to: 'export const quoteDocumentNoticeKey = (quoteId: string) => `sales.quote-document:${quoteId.toLowerCase()}:${Math.random().toString(36).slice(2)}`;' }],
    tests: [[CONTRACT, 'derives its key from the quote id only'], [SALES_IT, 'one issuance sends exactly one document']],
  },
  {
    name: 'QD-M11 a document notice failure fails the quote settlement (the issued quote is reported as not issued)',
    edits: [{ file: DOC, from: "        logger.warn({ event: 'quote.document.not_queued'", to: "        throw error;\n        logger.warn({ event: 'quote.document.not_queued'" }],
    tests: [[CONTRACT, 'a store failure is reported, never thrown']],
  },
];

function vitest({ project, file }, pattern) {
  const r = spawnSync('npx', ['vitest', 'run', '--project', project, file, '-t', `"${pattern}"`], { shell: true, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const count = (word) => Number(out.match(new RegExp(`Tests\\s+[^\\n]*?(\\d+) ${word}`))?.[1] ?? 0);
  return { status: r.status, passed: count('passed'), failed: count('failed'), out };
}

const key = ([target, pattern]) => `${target.file} :: ${pattern}`;
const unique = [...new Map(MUTATIONS.flatMap((m) => m.tests).map((t) => [key(t), t])).values()];
let baseline = true;
for (const t of unique) {
  const r = vitest(...t);
  const green = r.status === 0 && r.passed > 0 && r.failed === 0;
  if (!green) process.stdout.write(r.out);
  process.stdout.write(`baseline "${key(t)}": ${green ? `green (${r.passed} passed)` : 'RED'}\n`);
  baseline &&= green;
}
if (!baseline) {
  process.exitCode = 1;
  process.exit();
}

let failures = 0;
for (const m of MUTATIONS) {
  const originals = new Map();
  for (const e of m.edits) if (!originals.has(e.file)) originals.set(e.file, readFileSync(e.file, 'utf8'));
  const missing = m.edits.filter((e) => !originals.get(e.file).replace(/\r\n/g, '\n').includes(e.from));
  if (missing.length > 0) {
    process.stdout.write(`SKIPPED (anchor not found — update the mutation): ${m.name}\n`);
    failures += 1;
    continue;
  }
  const results = [];
  try {
    const mutated = new Map(originals);
    for (const e of m.edits) {
      const text = mutated.get(e.file);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      mutated.set(e.file, text.replace(/\r\n/g, '\n').replace(e.from, e.to).replace(/\n/g, eol));
    }
    for (const [file, content] of mutated) writeFileSync(file, content);
    for (const t of m.tests) {
      const r = vitest(...t);
      results.push(`${t[1]}: ${r.status !== 0 && r.failed > 0 ? `failed (${r.failed})` : 'PASSED'}`);
    }
  } finally {
    for (const [file, content] of originals) writeFileSync(file, content);
  }
  for (const [file, content] of originals) if (readFileSync(file, 'utf8') !== content) throw new Error(`${file} was not restored`);
  const detected = results.every((r) => !r.endsWith('PASSED'));
  if (!detected) failures += 1;
  process.stdout.write(`${detected ? 'DETECTED' : 'SURVIVED'}: ${m.name} [${results.join('; ')}]\n`);
}
process.stdout.write(`\n${MUTATIONS.length - failures}/${MUTATIONS.length} mutations detected; all sources restored\n`);
if (failures > 0) process.exitCode = 1;
