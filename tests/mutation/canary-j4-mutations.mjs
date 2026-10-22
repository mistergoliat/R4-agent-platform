// R4-J4-R5 preparation mutation checks of the canary tooling of sales-production@8: each mutation removes one
// guarantee (closed allowlist, J4 expired-evidence policy, single gateway, inspected ingest, rollback readiness,
// purge guard) and EVERY test listed for it must FAIL (each test is run alone, by name). Sources are restored byte
// for byte. Contract tests need no database; the integration tests use the local PostgreSQL.
//
//   npm run test:mutation:canary-j4
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CONTRACT = { project: 'contract', file: 'tests/contract/sales-canary-j4.test.ts' };
const INTEGRATION = { project: 'integration', file: 'tests/integration/sales-canary-j4.test.ts' };
const CIA_CONFIG = 'adapters/domains/identity/http/src/config.ts';
const IDENTITY = 'agents/sales/src/cli/canary/identity.ts';
const RUNTIME = 'agents/sales/src/cli/canary/runtime.ts';

const MUTATIONS = [
  {
    name: 'CJ4-M1 the CIA loader opens any non-loopback host (no allowlist)',
    edits: [{ file: CIA_CONFIG, from: '  if (!(options.allowedHosts ?? []).includes(base.hostname)) throw', to: '  if (false) throw' }],
    tests: [[CONTRACT, 'opens a non-loopback CIA or Customer Profile host only when listed']],
  },
  {
    name: 'CJ4-M2 an allowed CIA host may use plain http',
    edits: [{ file: CIA_CONFIG, from: "  if (base.protocol !== 'https:') throw new CustomerIdentityConfigError('invalid_customer_identity_config', 'an allowed non-local CIA host must use https');\n", to: '' }],
    tests: [[CONTRACT, 'opens a non-loopback CIA or Customer Profile host only when listed']],
  },
  {
    name: 'CJ4-M3 the allowlist accepts an IP literal',
    edits: [{ file: IDENTITY, from: "    if (!DNS_NAME.test(host) || /^[0-9.]+$/.test(host) || host === 'localhost'", to: "    if ((!DNS_NAME.test(host) && !/^[0-9.]+$/.test(host)) || host === 'localhost'" }],
    tests: [[CONTRACT, 'accepts exact lower-case DNS names only']],
  },
  {
    name: 'CJ4-M4 @8 runs without the J4 expired-evidence policy',
    edits: [{ file: RUNTIME, from: "    if (contextExpiredEvidence !== 'exclude') throw", to: '    if (false) throw' }],
    tests: [[CONTRACT, 'accepts @8 only with R4_CANARY_CONTEXT_EXPIRED_EVIDENCE=exclude']],
  },
  {
    name: 'CJ4-M5 a canary worker may run another expired-evidence policy than the declared one',
    edits: [{ file: RUNTIME, from: "    if (canary.contextExpiredEvidence !== null && (options.worker.context.expiredEvidence ?? 'include') !== canary.contextExpiredEvidence) {", to: '    if (false) {' }],
    tests: [[INTEGRATION, '@8 refuses real mode']],
  },
  {
    name: 'CJ4-M6 a second canary gateway may start (the singleton lock is not enforced)',
    edits: [{ file: IDENTITY, from: "    if (!won) throw replica('another canary gateway holds the canary gateway lock');\n", to: '' }],
    tests: [[INTEGRATION, 'refuses a second gateway and a platform gateway'], [INTEGRATION, 'singleton: of concurrent starts'], [INTEGRATION, 'crash recovery']],
  },
  {
    name: 'CJ4-M11 a canary gateway may start next to a platform gateway',
    edits: [{ file: IDENTITY, from: '    if (g.platform > 0) throw replica(', to: '    if (false) throw replica(' }],
    tests: [[INTEGRATION, 'refuses a second gateway and a platform gateway']],
  },
  {
    name: 'CJ4-M12 a gateway that lost its singleton lock keeps running',
    edits: [
      { file: IDENTITY, from: "    lock.on('error', onLost);\n    lock.on('end', onLost);\n", to: "    lock.on('error', () => undefined);\n" },
      { file: IDENTITY, from: "void lock.query('select 1').catch(onLost)", to: "void lock.query('select 1').catch(() => undefined)" },
    ],
    tests: [[INTEGRATION, 'crash recovery']],
  },
  {
    name: 'CJ4-M13 liveness no longer reads the lock (counts nothing)',
    edits: [{ file: IDENTITY, from: "              where locktype = 'advisory' and granted and classid = $1::oid and objid = $2::oid and objsubid = 2", to: '              where false' }],
    tests: [[INTEGRATION, 'singleton: of concurrent starts'], [INTEGRATION, '@7 is refused until protect_only']],
  },
  {
    name: 'CJ4-M7 the @8 worker runs without the canary gateway',
    edits: [{ file: RUNTIME, from: "      if (!options.customer) throw new PlatformError('precondition', 'canary_customer_config_missing', `${profileLabel(canary.profile)} needs the worker's R4_CUSTOMER_* configuration`);\n      await assertCanaryGatewayLive(pool);", to: "      if (!options.customer) throw new PlatformError('precondition', 'canary_customer_config_missing', `${profileLabel(canary.profile)} needs the worker's R4_CUSTOMER_* configuration`);" }],
    tests: [[INTEGRATION, 'refuses a second gateway and a platform gateway']],
  },
  {
    name: 'CJ4-M8 the @8 synthetic ingest bypasses the inbound inspector',
    edits: [{ file: RUNTIME, from: '      ...(inspector ? { inspector } : {}),\n', to: '' }],
    tests: [[INTEGRATION, 'the code never reaches the conversation'], [INTEGRATION, '@7 is refused until protect_only']],
  },
  {
    name: 'CJ4-M9 the rollback is ready while protection windows are open',
    edits: [{ file: IDENTITY, from: "ready: status.mode !== 'full' && status.openProtections === 0 &&", to: "ready: status.mode !== 'full' &&" }],
    tests: [[INTEGRATION, '@7 is refused until protect_only']],
  },
  {
    name: 'CJ4-M10 the purge runs while a canary component is connected',
    edits: [{ file: IDENTITY, from: "  if (Number(rows[0]!.n) > 0) throw new PlatformError('precondition', 'canary_purge_busy',", to: "  if (false) throw new PlatformError('precondition', 'canary_purge_busy'," }],
    tests: [[INTEGRATION, '@7 is refused until protect_only']],
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
