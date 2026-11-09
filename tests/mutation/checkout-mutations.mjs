// R4 Checkout integration (contract R-2/R-4) mutation checks: each mutation removes one guarantee of the Checkout
// capabilities (read before posting, explicit purchase request, explicit request for a new link, no payment operation
// on a purchase that needs a person, Checkout commands behind the kill switch, the same key after a lost answer, the
// R4 link margin, accreditation only from Checkout's COMPLETED; D7-6: the per-task financial limit and the sandbox
// isolation proof before every command; R-3: consent handed over only for its own quote) and EVERY test listed for it
// must FAIL (each test run alone, by name). Sources are restored byte for byte. The tests use the local PostgreSQL and
// a Checkout stub.
//
//   npm run test:mutation:checkout
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const IT = { project: 'integration', file: 'tests/integration/sales-checkout.test.ts' };
const PORT_UNIT = { project: 'unit', file: 'tests/unit/checkout/checkout-port.test.ts' };
const CAP = 'agents/sales/src/capabilities/checkout.ts';
const PORT = 'adapters/domains/src/checkout/port.ts';
const SALES = 'agents/sales/src/production/composition.ts';
const STORE = 'agents/sales/src/workspace/store.ts';
const HTTP_UNIT = { project: 'unit', file: 'tests/unit/checkout/checkout-http.test.ts' };
const CLIENT = 'adapters/domains/checkout/http/src/client.ts';
const CONSENT = 'adapters/domains/checkout/http/src/sandbox-consent.ts';

const MUTATIONS = [
  {
    name: 'CK-M1 no read-first: an open attempt is ignored',
    edits: [{ file: CAP, from: "const openAttempt = latest !== null && OPEN_ATTEMPT.has(latest.status) && !(latest.status === 'LINK_AVAILABLE' && latest.linkExpired);", to: 'const openAttempt = false;' }],
    tests: [[IT, 'read first'], [IT, 'a second execution']],
  },
  {
    name: 'CK-M2 a purchase starts without an explicit request',
    edits: [{ file: CAP, from: "if (!request) return rejected('purchase_not_requested'", to: "if (false) return rejected('purchase_not_requested'" }],
    tests: [[IT, 'refuses, with nothing sent']],
  },
  {
    name: 'CK-M3 a new link without the customer asking again',
    edits: [{ file: CAP, from: 'if (latest !== null && !explicitRequestSince(', to: 'if (false && !explicitRequestSince(' }],
    tests: [[IT, 'after Checkout resolves the attempt EXPIRED']],
  },
  {
    name: 'CK-M4 a payment operation on a purchase that needs a person',
    edits: [{ file: CAP, from: "if (status === 'HUMAN_INTERVENTION_REQUIRED' || CHECKOUT_ACCREDITED_STATUSES.has(status) || status === 'NOT_PURCHASABLE') {", to: 'if (false) {' }],
    tests: [[IT, 'ACTION_REQUIRED']],
  },
  {
    name: 'CK-M5 Checkout commands bypass the kill switch',
    edits: [{ file: SALES, from: "writeOperations: ['createSession', 'prepareSession', 'createPaymentAttempt']", to: 'writeOperations: []' }],
    tests: [[IT, 'the kill switch stops every Checkout command']],
  },
  {
    name: 'CK-M6 a retry after a lost answer uses a new Checkout key',
    edits: [{ file: CAP, from: "checkoutIdempotencyKey(context.executionKey, 'session')", to: "checkoutIdempotencyKey(`${context.executionKey}.${context.attempt}`, 'session')" }],
    tests: [[IT, 'lost answer']],
  },
  {
    name: 'CK-M7 a link inside the 60 s margin is still delivered',
    edits: [{ file: CAP, from: 'Date.parse(attempt.expiresAt) - CHECKOUT_LINK_SAFETY_MARGIN_MS <= now.getTime()', to: 'false' }],
    tests: [[IT, 'Checkout says expired']],
  },
  {
    name: 'CK-M8 the order is confirmed before Checkout reports COMPLETED',
    edits: [{ file: PORT, from: "if (session.status === 'PAYMENT_CONFIRMED_ORDER_PENDING' || a?.status === 'CAPTURED' || a?.status === 'SETTLED') return 'PAYMENT_ACCREDITED_ORDER_PROCESSING';", to: "if (session.status === 'PAYMENT_CONFIRMED_ORDER_PENDING' || a?.status === 'CAPTURED' || a?.status === 'SETTLED') return 'ORDER_COMPLETED';" }],
    tests: [[IT, 'orders listed while SYNCING'], [PORT_UNIT, '3 confirmed, order pending']],
  },
  // D7-6 (sandbox financial policy) and R-3 (sandbox consent source).
  {
    name: 'CK-M9 a purchase start ignores the per-task financial limit',
    edits: [{ file: CAP, from: 'const limited = await financialLimitReached(deps, taskId, context.executionKey);\n        if (limited) return limited;\n        const issued', to: 'const issued' }],
    tests: [[IT, 'D7-6: at most two']],
  },
  {
    name: 'CK-M10 a new payment attempt ignores the per-task financial limit',
    edits: [{ file: CAP, from: 'if (limited) return limited;\n          const created', to: 'const created' }],
    tests: [[IT, 'under D7-6 it is a third operation']],
  },
  {
    name: 'CK-M11 a repeated acceptance (same live session) counts as a second operation',
    edits: [{ file: STORE, from: 'select (select count(distinct session_id) from sales.checkout_sessions', to: 'select (select count(*) from sales.checkout_sessions' }],
    tests: [[IT, 'a second execution']],
  },
  {
    name: 'CK-M12 a Checkout command is sent without proving sandbox isolation',
    edits: [{ file: CLIENT, from: '    await this.#assertSandboxIsolation(options);\n', to: '' }],
    tests: [[HTTP_UNIT, 'refuses with nothing sent'], [HTTP_UNIT, 'each command reads the readiness first']],
  },
  {
    name: 'CK-M13 the readiness of another environment is accepted',
    edits: [{ file: CLIENT, from: 'body.environment === CHECKOUT_SANDBOX_ENVIRONMENT && ', to: '' }],
    tests: [[HTTP_UNIT, 'another environment']],
  },
  {
    name: 'CK-M14 a consent artifact for another quote or version is handed to Checkout',
    edits: [{ file: CONSENT, from: 'claims.quoteId !== request.quoteId || claims.quoteVersion !== request.quoteVersion || ', to: '' }],
    tests: [[HTTP_UNIT, 'nothing for another quote']],
  },
  {
    name: 'CK-M15 the per-task limit ignores attempts Checkout lists but R4 never recorded (F-E3A-1)',
    edits: [{ file: CAP, from: 'financialLimitReached(deps, taskId, context.executionKey, attempts.length)', to: 'financialLimitReached(deps, taskId, context.executionKey)' }],
    tests: [[IT, 'F-E3A-1']],
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
