# Quote Service — R1.1 Production Readiness & Remediation Audit

**Mode:** Architecture audit only. No implementation, production mutation, deployment change, or test execution was performed.  
**Date:** 2026-10-04  
**Decision status:** Recommendations for the Quote Service owner. This audit does not advance an R4 roadmap phase or authorize J3B.

## Authority and evidence scope

This report follows the R4 repository constitution and roadmap and the relevant boundaries in ADR-005, ADR-016, ADR-018, ADR-019, ADR-022, ADR-023, ADR-029 and ADR-032. Quote remains a domain service outside R4 Core. The existing code and production evidence summary are in [R4-J3A_QUOTE_OWNER_AUDIT.md](R4-J3A_QUOTE_OWNER_AUDIT.md); this R1.1 report supersedes that report’s R4 adaptation recommendations with the owner redesign below.

Evidence labels used below:

- **QS:** Quote Service repository at commit `fade75d`, paths relative to `E:\dev\codex\MS\MS-pesaschile-quote-service`.
- **R4:** this repository at commit `ae76a9e`.
- **OPS:** read-only production observations summarized in the existing J3A report, especially its sections A–B (`R4-J3A_QUOTE_OWNER_AUDIT.md:21-117`). The raw PM2/log transcript is not checked into this repository. No environment values or secrets were exposed.
- **TZ:** IANA Time Zone Database, the maintained source of civil-time and DST rules; see the citations in §G.

The production facts are dated observations, not claims inferred from code. Current-state code claims carry source file and line evidence. Where the production host’s raw output is not in the repository, that limitation is stated instead of fabricating a file citation.

No production host or database was accessed during this R1.1 pass; it reuses the prior read-only OPS record and performs source-level review only.

## A. Executive diagnosis

1. **The primary production failure is unavailable/unprovisioned PostgreSQL.** On the observed host, PM2 reported `quote-service` stopped after 2,595 restarts; the final startup log reported “Database is not reachable during startup validation”. The host had no listener on ports 3011 or 5432 and no Quote Service database was present in the observed deployment; the service’s only recorded request was a read on 2026-09-14. This is captured in the read-only OPS record (`R4-J3A_QUOTE_OWNER_AUDIT.md:21-56,80-117`).
2. **A code and supervisor interaction turns an unavailable dependency into a restart storm.** Startup validation checks PostgreSQL before `app.listen` completes and throws on failure (`QS: src/app.ts:140-148`; `QS: src/infrastructure/runtime/startup-validator.ts:14-25`; `QS: src/server.ts:6-14,59`). `main()` is launched without a rejection handler (`QS: src/server.ts:59`). PM2 then repeatedly restarts the non-zero process; the restart count is observed in OPS, while the exact PM2 restart policy was not preserved in the repository.
3. **Simply provisioning PostgreSQL is insufficient unless migrations, storage and renderer readiness are also correct.** Migrations are explicit rather than run by the server (`QS: package.json:13,22-27`; `QS: README.md:553`). Boot validation checks a DB ping, document storage writability and PDF renderer readiness, but does not validate schema version (`QS: src/infrastructure/runtime/startup-validator.ts:14-45`). HTTP readiness repeats dependency pings but also does not validate schema (`QS: src/application/health/readiness-service.ts:55-88`). An empty or stale database can therefore pass readiness and fail on quote requests.
4. **The existing owner is Model B:** it persists and renders the caller’s resolved commercial snapshot and verifies arithmetic. It does not discover products or obtain shipping; the caller supplies prices, tax treatment, customer and validity (`QS: src/http/routes/quote-route.ts:58-100`; `QS: src/domain/quote-line.ts:280-319`; `QS: src/domain/quote-pricing.ts:26-45`).
5. **The R4 Quote contract is based on a false ownership premise.** Its port says Quote prices lines from current Catalog and computes shipping (`R4: adapters/domains/src/quote/port.ts:3-20`), and the capability description repeats that claim (`R4: agents/sales/src/capabilities/quote.ts:64-78`). The real owner accepts caller-frozen values. R4 must redesign its adapter and fixture around that fact before integration.
6. **The owner should be redesigned as a generic quote domain service, not adapted around CRM Opportunity or R4 Task.** It should own identity, number, immutable issued snapshot, arithmetic verification, validity policy, lifecycle, document artifact, audit, idempotency and reconciliation. It must not own discovery, Catalog truth, inventory, freight rating, CRM truth, payments or agent behavior.
7. **Recommend both workflows:** an editable draft path for people/manual systems, and one idempotent create-and-issue command for transactional consumers. Email stays separate.
8. **J3B is blocked.** Production is unavailable; validity semantics and policy are not authoritative; correlation and shipping contracts are wrong; the owner has no direct idempotency reconciliation endpoint; R4’s fixture/API expectations are incorrect. Do not treat `/health` returning 200 as the gate.

## B. Keep / refactor / delete matrix

| Subsystem | Decision | Reason and source evidence |
|---|---|---|
| HTTP API | **REFACTOR** | Fastify and typed boundary validation have value, but retire V1 routes and publish one canonical V2 contract. Existing routes and request shapes are catalogued in the prior audit (`R4-J3A_QUOTE_OWNER_AUDIT.md:119-165`). |
| Quote creation | **REFACTOR** | The create transaction and caller snapshot are valuable. Add a single durable create-and-issue command; defer formal quote number assignment until issue is accepted. Current create always makes a draft and allocates a number (`QS: src/application/quote/quote-service.ts:226-283`). |
| Issue flow | **REPLACE** | Current issue commits idempotency before rendering files outside the transaction, then commits quote state. A crash can strand the idempotency key (`QS: src/application/quote/quote-service.ts:608-730`; `R4-J3A_QUOTE_OWNER_AUDIT.md:210-247,476-542`). Replace with durable `issuing` state and recoverable DB-backed work. |
| State machine | **REFACTOR** | Keep durable transitions and version checks; remove `accepted` and `paid` from Quote status; add `issuing` because it identifies committed, recoverable document issuance (`QS: src/domain/constants.ts:44-53`; `QS: src/domain/quote.ts:666-861`). |
| PostgreSQL schema | **REFACTOR** | Keep normalized quote, line, document, audit and delivery data. Remove required CRM Opportunity identity; add generic correlation, validity policy snapshot, shipping snapshot and durable operation/issuance state (`QS: src/infrastructure/persistence/postgres/migrations/000002_quote_persistence.cjs:20-35,229-289,332-386,388-453`; `QS: src/infrastructure/persistence/postgres/migrations/000004_quote_line_external_identity.cjs:9-25`; `QS: src/infrastructure/persistence/postgres/migrations/000005_quote_line_shipping.cjs:1-28`). |
| Migrations | **KEEP + HARDEN** | Explicit ordered migrations, locking and an explicit command are sound (`QS: src/infrastructure/persistence/postgres/migrator.ts:10-31`; `QS: src/scripts/migrate.ts:6-20`). Add schema-head validation, checksums and restore rehearsal. |
| Quote numbering | **KEEP + HARDEN** | Owner-owned sequence and unique constraint are right (`QS: src/infrastructure/persistence/postgres/quote-repository.ts:715-723`; migration 000002). Allocate at issue; permit gaps; remove fixed-width truncation risk beyond 999,999. |
| Idempotency | **KEEP + HARDEN** | Canonical request hashes and atomic create claim are useful. Add principal scope, durable in-progress lease/recovery, direct lookup and immutable request snapshots. Current issue can leave a permanent in-progress record (`QS: src/infrastructure/persistence/postgres/quote-repository.ts:762-860`; `R4-J3A_QUOTE_OWNER_AUDIT.md:476-542`). |
| PDF renderer | **KEEP + HARDEN** | Native renderer, content-addressed artifacts and document hashes are valuable. Correct local dates, tax wording, shipping details and immutable artifact recovery (`QS: src/infrastructure/documents/native-pdf-renderer.ts:130-228`; `QS: src/application/quote/documents/issued-quote-document.ts:83-168`). |
| Templates / branding | **REFACTOR** | Keep versioned templates and branding as issuer configuration. Remove validity and tax claims hard-coded independently of the quote snapshot (`QS: src/infrastructure/branding/pesaschile-brand-v1.ts:1-20`; `QS: src/infrastructure/documents/quote-email-view-model.ts:60-108`). |
| Email queue / worker | **KEEP + HARDEN** | Durable outbox, delivery rows, leases and retry classification have value. Keep email separate from issue; add ambiguous-send handling and pin recipient/document to the request (`QS: src/application/quote-delivery/quote-delivery-service.ts:131-235`; `QS: src/application/quote-delivery/quote-email-worker.ts:43-191`). |
| Gmail integration | **REFACTOR** | Keep as an optional provider adapter behind a generic mail port, not as Quote domain behavior. Credentials are currently Gmail-specific (`QS: src/infrastructure/email/gmail-email-sender.ts:12-13`; `QS: src/app.ts:102-125`). |
| Expiry scheduler | **KEEP + HARDEN** | Durable expiry state and DB claiming are useful; current scheduler defaults off and runs in-process (`QS: src/infrastructure/config/env.ts:57-59`; `QS: src/infrastructure/runtime/background-job-manager.ts:31-126`). Make expiry materialization reliable and never let scheduler lag misstate validity. |
| Audit events | **KEEP + HARDEN** | Append-only quote history is a domain responsibility. Add correlation and idempotency events, avoid PII and preserve event versions (`QS: src/application/quote/quote-service.ts:262-283`; `QS: src/infrastructure/persistence/postgres/migrations/000002_quote_persistence.cjs:388-453`). |
| Health / startup validation | **REPLACE** | Current dependency failure prevents binding and is not accompanied by a controlled boot policy. Current checks omit schema validity (`QS: src/server.ts:6-14,59`; `QS: src/infrastructure/runtime/startup-validator.ts:14-45`). |
| Configuration | **KEEP + HARDEN** | Zod parsing, bounds and production secret-strength checks are valuable (`QS: src/infrastructure/config/env.ts:30-127`). Separate runtime and migration credentials; validate readiness policy and surface sanitized dependency reasons. |
| Logging | **KEEP + HARDEN** | Fastify/Pino structured logging is configured (`QS: src/app.ts:55-62`), and job failures are logged (`QS: src/infrastructure/runtime/periodic-job-runner.ts:68-78`). Add domain events, correlation and redaction; do not log quote PII or raw keys. |
| Document storage | **KEEP + HARDEN** | Content-addressed filesystem storage works for the observed single-host design (`QS: src/infrastructure/documents/document-paths.ts:10-24`). Require persistent storage and backups; do not introduce object storage until multi-host availability requires it. |
| Opportunity coupling | **DELETE** | `opportunityId` is required in HTTP and SQL although it is not Quote identity (`QS: src/http/routes/quote-route.ts:87-94`; `QS: src/infrastructure/persistence/postgres/migrations/000002_quote_persistence.cjs:20-35`). Preserve any existing value only as a generic external reference during migration. |
| `accepted`, `paid` status and `mark-paid` | **DELETE** | Payment and deal acceptance are not quote issuance truth. Remove public V2 routes; keep any real historical events as legacy history, without claiming Quote owns payment (`QS: src/domain/constants.ts:44-53`; `QS: src/http/routes/quote-route.ts:410-468`). |
| Public expiry mutation route | **DELETE** | Expiry is determined by policy time and materialized by the owner scheduler. Remove caller-triggered `POST /expire`; restrict scheduler internals (`QS: src/http/routes/quote-route.ts:500-528`). |
| V1 API and compatibility shim | **DELETE** | No dual contract by default. Retire V1 after consumer and data inventory. Current usage observation shows no write traffic and one read (`R4-J3A_QUOTE_OWNER_AUDIT.md:21-56`). |
| Tests | **KEEP + HARDEN** | Unit, HTTP, persistence, migration, readiness, PDF and email tests exist (`QS: test/unit/domain-quote.test.ts:1`; `QS: test/integration/quote-http.integration.test.ts:1`; `QS: test/integration/migrations.integration.test.ts:1`; `QS: test/integration/quote-documents.integration.test.ts:1`; `QS: test/integration/quote-email-runtime.integration.test.ts:1`). Add failure injection, direct reconciliation, migration-data and process-crash coverage in §V. |

## C. Production failure root cause

### Trace

```text
PM2 quote-service
  → npm start / node dist/server.js
  → server main()
  → loadEnv()
  → buildApplication()
  → Fastify app.listen()
  → onReady hook
  → StartupValidator.validate()
  → PostgresDatabase.checkHealth()
  → database status = down
  → throw "Database is not reachable during startup validation"
  → app.listen() rejects before the port binds
  → main() rejects without a catch
  → process exits
  → PM2 restarts it
```

Code path: `QS: package.json:12-13`; `QS: src/server.ts:6-14,59`; `QS: src/app.ts:140-148`; `QS: src/infrastructure/runtime/startup-validator.ts:14-25`; `QS: src/infrastructure/persistence/postgres/postgres.ts:49-68`. PM2 state, restart count and the exact log text are the read-only OPS evidence recorded in `R4-J3A_QUOTE_OWNER_AUDIT.md:21-56,80-117`.

| Classification | Finding |
|---|---|
| **PRIMARY FAILURE** | PostgreSQL was unreachable and a Quote Service database was not provisioned/available in the observed deployment. The generic startup error is direct evidence of failed reachability, not of a specific DNS, port, password or TLS cause (OPS). |
| **SECONDARY FAILURE** | PM2 repeatedly restarted the process, accumulating 2,595 restarts before it stopped (OPS). The repository does not include the production PM2 config, so its retry cap/backoff cannot be proven from checked-in code. |
| **OPERATIONAL MISCONFIGURATION** | Database provisioning/endpoint and runtime credentials were not operationally valid. `DATABASE_URL` syntax passed parsing because execution reached the startup validator; no secret or actual URL was inspected. |
| **CODE DEFECT** | A dependency outage is treated as fatal boot failure; `void main()` has no controlled rejection handling; the failure message suppresses actionable sanitized cause. Boot/readiness also omit schema validation (`QS: src/server.ts:59`; `QS: src/infrastructure/runtime/startup-validator.ts:20-25`; `QS: src/application/health/readiness-service.ts:55-88`). |

### Would PostgreSQL provisioning alone stabilize it?

Not necessarily. With a reachable but unmigrated database, startup’s ping and current readiness checks can pass while quote queries fail because the schema is absent or stale. With migrations at the expected head, usable persistent document storage and a ready renderer, this source contains no additional unconditional crash loop; the application should bind and stay up under those conditions. Email and expiry jobs are not required for boot, and expiry defaults off (`QS: src/infrastructure/config/env.ts:57-67`; `QS: src/app.ts:112-148`). Repeated write-runtime reliability defects still require repair: issue may strand an idempotency row, and email delivery is at-least-once (`R4-J3A_QUOTE_OWNER_AUDIT.md:210-247,476-542,412-439`). The source cannot prove current production environment values or PM2 retry configuration.

## D. Target domain ownership

| Quote Service owns | Quote Service does not own |
|---|---|
| Quote ID and quote number; draft and issue lifecycle; immutable issued commercial snapshot; arithmetic verification; owner validity policy and expiry; issued PDF/HTML artifact references and hashes; append-only quote audit history; caller correlation metadata; idempotency and reconciliation; optionally, explicitly requested quote email delivery as a separate delivery subsystem. | Product discovery or recommendations; current Catalog/Product truth or price selection; inventory; Shipping rate lookup or carrier selection; customer CRM identity/master data; payment processing or paid status; sales opportunities; agent goals, reasoning or policy; R4 tasks or workspace state. |

**D.1 Identity.** A quote is identified by its owner-generated `quoteId`; its public/business identifier is the owner-generated quote number. An external ID is correlation metadata only.  
**D.2 Commercial truth.** Quote Service preserves the caller’s commercial snapshot and verifies that the supplied numbers reconcile. It does not decide whether the caller selected a correct product or current price.  
**D.3 Email.** Quote delivery can remain colocated as an optional subsystem because the service already has an outbox and quote document attachment. It is never part of quote issuance; a future notification service may own delivery if real consumers need independent delivery channels.  
**D.4 R4 boundary.** The quote adapter and Sales workspace remain outside R4 Core under ADR-005 and ADR-023. No Quote tables, CRM tables or Quote-specific primitives enter Core.

## E. Canonical state machine

Target quote states: `draft`, `issuing`, `issued`, `expired`, `cancelled`. Keep attempt and delivery states separate from quote status.

| State | Durable meaning | Allowed mutations | Document | Retry and recovery |
|---|---|---|---|---|
| `draft` | Caller snapshot exists and is editable; no formal issue commitment. | Replace customer/commercial snapshot with `expectedVersion`; issue; cancel. Validity policy is not yet finalized. | None. | Create/update replay returns the same draft for the same key and payload. |
| `issuing` | An immutable issue snapshot, idempotency record, issue effective time, number reservation and recoverable issuance operation have committed. No more commercial edits. | Query/replay same operation. Cancel is rejected while a fenced attempt is active; the owner can cancel only after a safe pre-render state is established. | Not available to consumers yet. | Retry or reconcile the same operation under a DB lease/fencing generation. Never create a second quote or number for a replay. |
| `issued` | Immutable quote and document artifact manifest are committed; PDF hash, render/template versions and issue time are durable. | Cancel, expire by policy, read, request delivery. Never edit; a new commercial version is a new quote. | Available, immutable. | Replay returns the original issued quote. Missing artifact invokes verified repair from pinned inputs or an operator incident; never render with current template and overwrite. |
| `expired` | Validity boundary elapsed; quote is no longer valid for new acceptance. Historical quote and document remain. | Read; optionally cancel for audit closure. No revival. | Historical document remains available and still states its original validity. | Expiry is idempotent; scheduler catch-up and reads must not represent it as currently valid. |
| `cancelled` | Owner recorded cancellation; no further issue or delivery request. | Read only. | If it had been issued, historical document remains available. | Repeated cancel returns same state; cancellation cannot undo email already accepted by a provider. |

Transitions:

```text
draft → issuing → issued → expired
  └────────────→ cancelled     issued → cancelled
```

`issuing` is warranted by the concrete invariant that artifact generation is outside a PostgreSQL transaction. It gives a durable place to resume after process death. `accepted` is not a quote state in V2; if a future consumer needs a customer decision, model an attributed decision event with evidence. `paid` belongs to Payment/Order, not Quote. Email delivery states remain `pending`, `sending`, `sent`, `failed` or `unknown` in the delivery subsystem.

## F. Create vs issue decision

| Design | Evaluation |
|---|---|
| **A. Draft then issue only** | Clean manual editing and approval workflow. Two calls for transactional consumers; timeout between calls requires storing draft ID and reconciling issue separately. |
| **B. Create-and-issue only** | Simple integration and atomic request identity. Poor fit for a person who must review/edit a draft before issue. |
| **C. Both** | One commercial snapshot contract; manual systems use draft, integrations use one idempotent create-and-issue command. The issue operation is durable and can return `202` while the PDF is generated. |

**Recommend C.** `POST /v2/quotes` creates and issues for integrations: in one DB transaction, bind the idempotency key and fingerprint, freeze the complete snapshot, choose the validity policy, reserve the owner number and commit `issuing`. A DB-backed worker renders and commits the artifact manifest before changing to `issued`. Return `201` only when completed synchronously; otherwise `202` with quote and operation references. Replay while issuing returns that same operation, not a new quote.

Manual/human flows use `POST /v2/quotes/drafts`, versioned draft edits, then `POST /v2/quotes/{id}/issue`. This flow does not weaken the create-and-issue invariant for a transactional execution key. No create or issue operation sends email.

## G. Validity policy

**Decision: D — owner-configured default policy plus an explicit privileged override.** The Quote owner defines, versions and stamps its active policy on issue. Normal callers do not calculate `validUntil`; do not provide an untrusted arbitrary `validUntil`. A caller with `quotes.validity.override` may request an exact offset-bearing instant and must supply a reason; the override actor, reason and chosen instant are audited. Policy choice/default version and resolved expiry are frozen on first execution so a retry after configuration changes reproduces the same quote.

The current “5 days” is email copy, not a service policy (`QS: src/infrastructure/branding/pesaschile-brand-v1.ts:6`; `QS: src/infrastructure/documents/quote-email-view-model.ts:100-108`; `R4-J3A_QUOTE_OWNER_AUDIT.md:440-460`). Recommend a configurable standard policy. **Do not make five days authoritative until the commercial owner signs off.** Email and PDF render the resolved quote validity, never an independent day-count constant.

Time semantics for the recommended Chile market profile:

- Validity is measured from the owner’s durable issue effective instant, not draft creation.
- Define policy duration as a count of **Chile civil calendar dates**, counting the issue date as day one. For a five-date example, the quote is valid through the fifth local date; `validUntilExclusive` is the first valid instant at the start of the following local date. Compare expiry using `now >= validUntilExclusive`.
- Use a configured issuer/market time zone, not the customer’s shipping destination. For a Santiago-operated PesasChile quote the default is `America/Santiago`. For a service that covers all of Chile, select the configured zone for the issuing market/territory; do not assume one national offset. The current IANA database has distinct rules/zone identifiers for `America/Santiago`, `America/Coyhaique`, `America/Punta_Arenas` and `Pacific/Easter`; IANA notes that time-zone rules change through political decisions and publishes updates ([IANA Time Zone Database](https://www.iana.org/time-zones), [South America zone source](https://data.iana.org/time-zones/tzdb/southamerica)).
- Compute local date boundaries with the IANA time-zone database. Do not add 24-hour milliseconds per calendar day or hard-code a UTC offset. Resolve a skipped/ambiguous midnight to the first valid instant of the next local date; store the resulting UTC instant and the policy zone/version.
- API fields use RFC 3339 UTC instants with `Z`, named `validUntilExclusive`; PDF shows the inclusive local date and zone, e.g. “Válida hasta DD/MM/YYYY inclusive, hora de Chile”. Existing PDF formats timestamps as UTC dates (`QS: src/application/quote/documents/document-formatting.ts:45`; `QS: src/application/quote/documents/issued-quote-document.ts:132-137`).

DST days can be 23 or 25 hours; the calendar boundary still means the same declared local date. The expiry job must catch up after downtime. `issued` may not be presented as valid once the instant boundary passes, even while expiry materialization is lagging.

## H. External reference model

`opportunityId` is not quote identity. Remove it from the required V2 contract and from the required database column. Introduce:

```text
externalCorrelation {
  sourceSystem: required stable caller identifier
  externalReferenceType: optional caller-defined type
  externalReference: optional opaque ID
  correlationId: optional request/trace ID
}
```

A reference does not need to be unique because one task, customer case or CRM record may legitimately lead to several quotes. Provide query by source/type/reference and return a list. The R4 task ID can be stored as `sourceSystem=r4-sales`, `externalReferenceType=task`, `externalReference=<opaque task ID>`; it must never be called an Opportunity. Quote ID and quote number remain independent. `sourceSystem` maps the current caller `source.system`; correlation is not used as the idempotency key (`QS: src/domain/source-ref.ts:5-17,37-38`; `QS: src/http/routes/quote-route.ts:87-94`; `R4: agents/sales/src/capabilities/quote.ts:91-99`).

## I. Idempotency and reconciliation target

**Invariant:** within an authenticated caller/principal scope, the same create execution key can bind to at most one logical quote for the lifetime of that quote. Store the key binding or a tombstone for at least as long as the quote is retained. Scope is `(principal, operation, key)`; a key never crosses principals.

- Require `Idempotency-Key` for create-and-issue, create draft, draft update, issue, cancel and email queueing.
- Canonicalize the semantic request and persist its SHA-256 fingerprint plus the frozen request snapshot before external document work. Same key/same fingerprint returns current operation/quote; same key/different fingerprint returns `409 idempotency_key_conflict`.
- Use a durable operation ID and lease/fencing generation for issuance. Reclaim expired leases; store attempt outcome separately. Render to a content-addressed deterministic location and make the final DB manifest commit idempotent.
- Provide an authenticated direct read by key, scoped to the caller, plus `GET /v2/operations/{operationId}`. A caller that loses the HTTP response can query by its stable key without database access. Query by external reference is a useful second recovery path, not the uniqueness mechanism.
- `unknown` means the owner has not yet established whether the operation committed; it never means failed. Replaying the exact frozen command is safe. A not-found read is authoritative only if the key record and all corresponding operation transactions are committed/visible.
- After a process crash before DB commit, the caller may replay and create the one quote. After commit but before response, lookup/replay returns that quote. After PDF write but before manifest commit, a worker safely reuses/verifies the content-addressed artifact. After manifest commit but before response, lookup returns issued. No caller reads Quote tables.
- If a quote’s payload changes, issue a new quote with a new execution key. Do not mutate an issued snapshot.
- Keep a durable audit event for replay and conflict; never log the raw idempotency key.

Today’s V1 create is transactionally idempotent, with canonical payload conflict detection; there is no key lookup. V1 issue commits its key claim before rendering, and a crash can leave `in_progress` permanently (`QS: src/infrastructure/persistence/postgres/quote-repository.ts:762-860`; `R4-J3A_QUOTE_OWNER_AUDIT.md:476-542`). The R4 adapter assumes `findByIdempotencyKey` exists (`R4: adapters/domains/src/quote/port.ts:9-20,61-64`), but V1 has no matching route. V2 must supply the reconciliation path.

## J. Commercial snapshot contract

Quote Service is Model B. Caller freezes the values; Quote validates shape, verifies arithmetic and stores/render them. It never queries Catalog or Shipping.

Recommended quote request snapshot:

- **Product identity:** opaque source system and product/variant IDs, SKU if known, frozen customer-facing name/description, variant attributes and optional source catalog version/as-of time.
- **Quantity:** explicit decimal-string quantity and unit. Never use binary float as a durable money/quantity representation.
- **Unit price:** integer CLP amount, currency and an explicit tax basis. Do not send a Catalog “from” price; caller must send the resolved amount for the exact selected variant and quantity tier.
- **Tax:** each line declares included, excluded or exempt treatment, the supplied rate when applicable, and optional policy/source reference. Quote verifies the math; it does not decide legal tax rate or fetch a fiscal policy.
- **Discounts:** V1 has no discount field (`QS: src/domain/quote-line.ts:20-57`; `QS: src/infrastructure/persistence/postgres/migrations/000002_quote_persistence.cjs:229-289`). Do not add promotion or discount calculation to Quote. If callers need discounts, accept explicit caller-resolved adjustment snapshots with amount, description, tax treatment and allocation reference. Caller allocates across tax bases; Quote only verifies and sums.
- **Customer:** immutable customer snapshot defined in §L.
- **Shipping:** separate structured snapshot defined in §K.
- **Validity:** resolved owner policy reference/version and `validUntilExclusive`; normal callers do not choose the default expiry.
- **Provenance:** generic external correlation and pricing source/as-of values. No R4-specific primitive.

Arithmetic owned by Quote:

1. Parse CLP amounts as integer pesos and quantities/rates as exact decimal values.
2. Extend unit amount by quantity using the declared tax basis and the single published rounding rule.
3. For tax-inclusive lines, derive net from the rounded gross and supplied rate; tax is gross minus net.
4. For tax-exclusive lines, derive tax from the rounded net and supplied rate; gross is net plus tax.
5. Exempt lines have zero tax and retain explicit exempt treatment.
6. Apply half-up rounding at documented line boundaries, then sum rounded net/tax/gross totals. Reject overflow, unsupported currency, malformed rates and inconsistent supplied subtotals.

The current implementation already uses half-up CLP arithmetic, computes line net/tax/total and sums rounded line results (`QS: src/domain/money.ts:17-23,73-75`; `QS: src/domain/quote-line.ts:280-319`; `QS: src/domain/quote-pricing.ts:26-45`). Keep that deterministic role, publish it as the only arithmetic contract, and return the owner totals to callers. Catalog and R4 must not independently re-total the issued quote.

## K. Shipping snapshot

Do not call Shipping. Preserve carrier semantics as a structured shipping charge instead of a generic line only:

```text
shipping {
  carrier: { code?: string, name: string }
  serviceType?: { code?: string, name?: string }
  destination: { commune: string, region?: string, country: "CL" }
  amount: { amount: integer CLP, taxBasis: included | excluded | exempt, taxRate?: decimal }
  sourceQuote?: { sourceSystem: string, reference?: string, asOf: RFC3339 instant }
}
```

`amount` is the caller-resolved shipping price input; output separately records the derived tax/net and the customer-payable gross. If the upstream owner returns a net amount and separately computed gross under a named policy, preserve that source amount and policy reference as provenance. The Quote calculation must use exactly one declared input basis and must not re-rate freight or infer carrier/service. This preserves at least carrier, service type if available, destination commune, customer-facing amount and tax basis. Current V1 has only `type:"shipping"` and label “Despacho”; carrier can only be hidden in description and no structured destination/carrier/service fields exist (`QS: src/domain/constants.ts:55`; `QS: src/application/quote/documents/issued-quote-document.ts:147-159`; `R4-J3A_QUOTE_OWNER_AUDIT.md:307-334`). ADR-032 states Shipping returns source amounts and R4 adapter preserves its net/gross policy; Quote should snapshot that explicit answer, not call pc-carrier (`R4: docs/adr/ADR-032-production-shipping-adapter.md:3-15,60-75`).

## L. Customer snapshot

Do not require CRM identity. Store a quote-specific snapshot:

```text
customer {
  kind: guest | person | company
  displayName?: string
  legalName?: string
  tradeName?: string
  rut?: string
  email?: string
  phone?: string
  billingAddress?: { lines, commune, region, postalCode?, country }
  externalCustomerReference?: { sourceSystem, reference }
}
```

For a person/company, require a usable display or legal name; for a guest, name and contact may be absent unless the selected output/delivery requires them. Do not fabricate “anonymous customer” data. RUT is optional; syntactic validation is not CRM identity verification. Email and phone are optional at quote creation and immutable when issued; email delivery requires a specific recipient snapshot. Billing fields are optional. No customer-master lookup is required.

Current V1 requires customer name but allows optional email/phone/address and an opaque optional `customerId`; it has no RUT or billing model (`QS: src/http/routes/quote-route.ts:48-56,89`; `QS: src/domain/customer-snapshot.ts:34-73`; `R4-J3A_QUOTE_OWNER_AUDIT.md:335-357`). R4’s quote input currently forces email or phone (`R4: agents/sales/src/capabilities/quote.ts:15-23`); V2 can support guest/manual consumers without relaxing any email-delivery recipient check.

## M. PDF target

Keep an issued document as an immutable artifact:

- `issued` is the only state with a customer-visible PDF. Drafts and issuing operations have no available document.
- The PDF contains the owner quote number, issue date, local validity-through date, customer snapshot, product names/SKUs/variants/quantities, each caller-resolved charge, explicit shipping carrier/service/commune, consistent net/tax/gross values and the issue-time state “issued”.
- Display tax labels per declared tax basis. Do not print the universal “Precios incluyen IVA” unless every line and shipping amount supports it. Current PDF and email both use that fixed note (`QS: src/application/quote/documents/issued-quote-document.ts:161-165`; `QS: src/infrastructure/documents/quote-email-view-model.ts:96-108`).
- Display issue/expiry in the configured Chile civil time zone. Current formatter explicitly uses UTC date semantics (`QS: src/application/quote/documents/document-formatting.ts:45`; `QS: src/application/quote/documents/issued-quote-document.ts:132-137`).
- Store exact PDF bytes immutably by content hash, plus semantic snapshot hash, SHA-256, renderer version, template version, generated timestamp and artifact reference. Return the same bytes on every normal read.
- Do not rewrite an issued PDF when a quote expires or is cancelled. The API reports current state; the original PDF remains a historical issue artifact. A correction is a new quote with a new number.
- If an artifact is missing or corrupt, regenerate only with the pinned renderer/template from the identical canonical snapshot, then require its recorded byte hash to match. If bytes cannot be reproduced exactly, open an operator-visible repair incident; do not silently replace the customer’s historical artifact.

V1 already has canonical document snapshots, render version, hashes and immutable content-addressed paths (`QS: src/application/quote/documents/issued-quote-document.ts:83-122`; `QS: src/infrastructure/documents/document-paths.ts:10-24`; `R4-J3A_QUOTE_OWNER_AUDIT.md:391-411`). Preserve that investment while fixing date/tax/shipping semantics.

## N. Email

Keep email separate from issue and optional in owner composition.

- Queueing is an explicit operation. Issuing a quote never sends mail.
- Persist immutable recipient snapshot, quote ID, document reference and SHA-256, email template version, idempotency key, requested-by principal, queued time, attempt count and delivery outcome.
- Queue and audit write happen in one DB transaction. Worker leases/fencing prevent concurrent dispatch; retry only failures known not to have been accepted. Ambiguous provider acceptance becomes `unknown` and is reconciled or reviewed; do not blind-retry an email that may already have been sent.
- Deduplicate the same delivery request/key; a new explicit key may represent a deliberate second email.
- Delivery failure or missing Gmail credentials never changes an issued quote’s status or document.
- Keep Gmail as a replaceable provider adapter. Store credentials in managed secrets; rotate and scope them. Tests use a fake sender and never send real email.

V1 separates email request from quote creation/issue and has a DB outbox and async worker (`QS: src/application/quote-delivery/quote-delivery-service.ts:131-235`; `QS: src/application/quote-delivery/quote-email-worker.ts:43-191`). Its retry can resend after provider acceptance if the process dies before recording success, so it is at-least-once (`R4-J3A_QUOTE_OWNER_AUDIT.md:412-439`). Preserve that honesty in state; current delivery request replay does not make Gmail exactly-once.

## O. Database and bootstrap target

### Lifecycle

1. Provision managed PostgreSQL database, schema and network path through deployment infrastructure. Quote Service never creates its database.
2. Create separate least-privilege roles: migration role can create/alter owned schema objects; runtime role can connect and perform only required quote/delivery DML and sequence use. Current process has one `DATABASE_URL` (`QS: src/infrastructure/config/env.ts:43-48`); split migration and runtime secret/config.
3. Take a database backup/snapshot and verify restore before first V2 migration. Inspect the database and document root for real rows/artifacts; unavailable runtime does not prove there is no backup data.
4. Run one explicit release migration command, such as the compiled `db:migrate:runtime` script, using the migration role. Current migrations use `schema_migrations`, check order and a lock (`QS: src/infrastructure/persistence/postgres/migrator.ts:10-31`; `QS: package.json:22-27`).
5. Run a read-only schema/version validation command and record migration head/checksum. The server must not run DDL or auto-migrate.
6. Start or resume the service. Boot liveness stays available; readiness reports database/schema/storage/renderer states. A stale schema never receives writes.
7. Retain an explicit forward correction/restore plan. Do not use automatic migration rollback in production.

### Production behavior

The target process does not enter an uncontrolled restart loop for a transient PostgreSQL outage. Bind health routes after static config validation; return liveness as alive; return readiness as unavailable with a sanitized dependency code; reject business operations with 503 until dependencies recover. Alert and retry connections with bounded backoff. A process may exit for invalid static configuration or unrecoverable local corruption, but PM2 must use a capped restart window and alert when exhausted. Do not make PM2 the database recovery mechanism.

## P. Health, readiness and dependency health

Replace the current two-route ambiguity (`/health` is a DB check, `/health/ready` checks DB, storage and renderer; `QS: src/http/routes/health-route.ts:30-41`; `QS: src/application/health/health-service.ts:28-40`; `QS: src/application/health/readiness-service.ts:55-88`) with:

- `GET /health/live`: process/event loop can answer HTTP; no dependency probe; 200 while process is responsive.
- `GET /health/ready`: suitable for quote traffic; checks migration/schema head, DB connectivity, required artifact-store write/read, renderer readiness and shutdown phase; 200 only when all required functions work, otherwise 503.
- `GET /health/dependencies` (internal, authenticated or network-limited): sanitized per-dependency status, failure category and last-success time. Never return hostnames, DSNs, stack traces or secrets publicly.
- DB outage after boot removes the instance from traffic and yields dependency health detail. It does not kill/restart the process.
- Startup validation confirms static config and local invariant checks. Dependency unavailability is degraded/unready, not a hot crash loop.
- Expiry and issuance workers expose their last successful poll, queue age/depth and oldest operation. `/health/ready` is not the only operational signal.

A 200 from the present `/health` means only a DB ping passed; it is not quote service readiness and certainly not R4 readiness.

## Q. Security

- Require service-to-service authentication on all quote, idempotency, operation, audit, delivery and document routes. Replace one shared static Bearer credential with separate caller identities/scopes and rotation; support mTLS or equivalent workload identity where available.
- Restrict network ingress to approved services. Current server defaults to `0.0.0.0`, and auth is a single token (`QS: src/infrastructure/config/env.ts:33,51`; `QS: src/http/service-auth.ts`; prior audit §B and §S).
- Authorize PDF retrieval against quote ID and caller scope. A document reference is not public authorization. If email or messaging requires a recipient download, issue a narrowly scoped, time-limited retrieval capability or have the trusted channel adapter fetch it.
- Store DB, mail and document-signing secrets in the deployment secret manager; use distinct secrets, least privilege and rotation. No secret in response bodies, telemetry, audit payloads or model prompts.
- Redact customer name, RUT, email, phone, address and message body from request logs and traces. Mask delivery destinations in operational logs; restrict and audit access to quote snapshots/documents.
- Keep caller-provided actor/source fields as claims unless bound to authenticated principal by the service. Never let request JSON self-assert a privileged actor or validity override.
- Set retention and deletion policy for customer PII and issued artifacts before production.

## R. Observability

Emit structured, versioned domain events for:

- `quote.created`
- `quote.issue.started`
- `quote.issued`
- `quote.issue.failed`
- `quote.expired`
- `quote.cancelled`
- `quote.email.queued`
- `quote.email.sent`
- `quote.email.failed` / `quote.email.unknown`
- `idempotency.replayed`
- `idempotency.conflict`

Every event carries `quoteId` when known, `quoteNumber` when issued, generic `externalReference` fields, `correlationId`, authenticated principal ID, operation ID, outcome code, timestamp, latency and policy/template versions where relevant. Record only a hash of the idempotency key. Never add customer PII, raw email, RUT, phone, address or full line payload to logs. Keep the durable audit payload minimal and append-only.

V1 has quote and email audit rows, and masks a recipient in worker logs (`QS: src/application/quote/quote-service.ts:262-283`; `QS: src/application/quote-delivery/quote-email-worker.ts:19-28`). Extend this pattern; do not add chain-of-thought. R4 needs owner correlation plus its own ActionProposal/Receipt ledger under ADR-016/018.

## S. Proposed API V2

All routes except health require authenticated service identity and explicit scopes. All mutations require `Idempotency-Key`; request fingerprints cover the entire semantic body, including customer, lines, shipping, external correlation, validity override and actor-bound provenance. Error body is stable `{error:{code,message,correlationId}}`, without PII or database internals.

| Method and route | Request | Success | Idempotency | Side effects | Errors |
|---|---|---|---|---|---|
| `POST /v2/quotes` | Frozen customer/commercial/shipping snapshot, external correlation, optional privileged validity override and reason. | `201` with issued quote; `202` with quote ID + operation location while `issuing`. | Required. Same key returns same quote/current operation; differing body `409`. | Persist snapshot, policy resolution, number and issuance operation; generate/store PDF; no email. | `400/422` schema or arithmetic; `401/403`; `409` key conflict; `503` DB/storage/render unavailable before durable acceptance. |
| `POST /v2/quotes/drafts` | Same shared snapshot schema; no final validity resolution needed until issue. | `201` draft, quote ID and version; no quote number required yet. | Required. | Persist editable draft; no PDF, email or external call. | `400/422`, `401/403`, `409`, `503`. |
| `PATCH /v2/quotes/{quoteId}/draft` | Full replacement or explicit patch, `expectedVersion`. | `200` updated draft/version. | Required; expected version mandatory. | Replace draft snapshot, append audit event. | `404`, `409` state/version/key conflict, `400/422`, `503`. |
| `POST /v2/quotes/{quoteId}/issue` | `expectedVersion`, optional privileged validity override. | `202` operation or `200` issued quote when synchronous. | Required; binds one issue operation to quote. | Freeze snapshot, owner validity, number, render artifact, audit. No email. | `404`, `409` invalid state/version/key conflict, `403` override denied, `422`, `503`. |
| `GET /v2/quotes/{quoteId}` | None. | Current quote state, immutable snapshot, verified totals, validity policy, artifact metadata and version. | None. | Read only. | `401/403`, `404`, `503`. |
| `GET /v2/quotes?sourceSystem=&externalReferenceType=&externalReference=&status=&limit=&cursor=` | At least a caller-scoped correlation filter for external lookup. | Page of quotes; several quotes may match a reference. | None. | Read only. | `400`, `401/403`, `503`. |
| `GET /v2/operations/{operationId}` | None. | Durable issue operation state, attempts summary and quote ID. | None. | Read only. | `401/403`, `404`, `503`. |
| `GET /v2/idempotency/current` | `Idempotency-Key` header; caller identity supplies scope. | `not_found`, `in_progress`, `completed` plus quote/operation reference, or stored deterministic rejection. | This is the lookup path; no mutation. | Read only. | `401/403`, `400` missing key, `503`. |
| `POST /v2/quotes/{quoteId}/cancel` | Reason code and optional note without PII. | `200` cancelled quote/current state. | Required. | State transition + audit; cannot retract already accepted delivery. | `404`, `409` state conflict, `400/422`, `503`. |
| `GET /v2/quotes/{quoteId}/document` | None. | Exact stored PDF bytes with SHA-256 header; authorized caller. | None. | Read only; no rerender. | `401/403`, `404` if not issued, `503` artifact unavailable. |
| `GET /v2/quotes/{quoteId}/audit?limit=&cursor=` | None. | Caller-authorized event page. | None. | Read only. | `401/403`, `404`, `400`, `503`. |
| `POST /v2/quotes/{quoteId}/deliveries/email` | Recipient snapshot, template/profile selection if authorized. | `202` delivery ID and queued state. | Required; replay returns same delivery. | Write delivery + outbox + audit; worker sends separately. | `404`, `409`, `422` invalid/missing recipient/document, `403`, `503` queue unavailable. |
| `GET /v2/quotes/{quoteId}/deliveries/{deliveryId}` | None. | Delivery state, attempts summary, pinned doc hash and recipient mask. | None. | Read only. | `401/403`, `404`, `503`. |

Use consistent error codes: `invalid_request`, `validation_error`, `arithmetic_mismatch`, `unauthenticated`, `forbidden`, `quote_not_found`, `document_not_available`, `invalid_state_transition`, `version_conflict`, `idempotency_key_conflict`, `operation_in_progress`, `dependency_unavailable`, `schema_not_ready`, `document_generation_failed`, `document_storage_failed`, `delivery_recipient_missing`. Never return raw PostgreSQL/Gmail errors.

The existing V1 surface includes draft create, list/lookups, draft update, issue, accept, mark-paid, cancel, expire, revisions, documents, audit and email deliveries (`R4-J3A_QUOTE_OWNER_AUDIT.md:119-165`). Retire it as specified in §T after the consumer/data inventory. Do not preserve its route contract by default.

## T. V1 retirement plan

Retire the full `/v1/quotes...` and `/v1/documents...` API surface, including:

- `POST /v1/quotes` and `PUT /v1/quotes/{id}/draft`
- issue and revision endpoints
- accept, mark-paid and public expire endpoints
- list/by-number/by-ID reads
- document listing and document-reference route
- audit, send-email and delivery routes

Keep unversioned liveness/readiness endpoints with their new semantics. Do not implement a compatibility shim. Before cutover, inventory source repositories, deployed callers, credentials and DNS/network policy. The production observation found no mutation and one read, but CRM source code still exists (`R4-J3A_QUOTE_OWNER_AUDIT.md:21-56,80-117`); verify that it is not deployed or active before retiring routes. Publish one V2 OpenAPI contract and a cutover date. Stop V1 traffic, migrate data, deploy V2 and reject residual V1 requests with a clear `410 api_version_retired` response for a short agreed window if the gateway supports it; do not dual-write or dual-run.

## U. Migration strategy

Choose an aggressive single-contract migration; preserve data, not the incorrect contract.

1. Inventory deployed callers, quote rows, event rows, delivery/outbox rows, idempotency keys and document files from the live database **and** its latest backup. Production DB unavailability means current absence cannot be inferred from backup state.
2. Take a verified backup and restore it in an isolated environment. Compare row counts and document hashes.
3. Design one forward migration from current schema to V2. Preserve quote IDs/numbers, immutable snapshots, issue timestamps, hashes, PDFs/HTML, audit events and delivery history.
4. Map known `opportunityId` to `externalCorrelation` with `sourceSystem=crm` and `externalReferenceType=opportunity_id`; where provenance is uncertain preserve the old value under a clearly typed legacy reference. Never put R4 task IDs in this field.
5. Preserve historical `accepted`/`paid` facts as legacy audit events or explicit source events. Do not silently claim Quote Service remains payment truth, and do not discard historical state. Map only semantics that are provable.
6. Convert legacy caller-supplied `validUntil` to a legacy validity snapshot with source marked `caller_supplied`; do not retroactively recalculate an issued PDF’s date.
7. Keep issued documents byte-identical. Reconcile artifact paths and hashes; if a file is missing, preserve the metadata and open a migration exception rather than regenerate with V2 templates.
8. Verify up migration, data mapping, rollback/restore procedure and API contract in a restored copy. Production migration is forward-only after backup; do not run `down`.
9. Cut consumers over to V2, disable V1 and observe only V2. Do not run both APIs or add a shadow legacy schema. If inventory confirms no rows, migration still records that verification evidence and retains backup through the agreed retention window.

## V. Test strategy before production readiness

Tests required as part of the implementation; this audit did not run or add them.

| Area | Required coverage |
|---|---|
| Unit | State transitions and version fencing; canonical request hashing; tax included/excluded/exempt arithmetic; CLP boundaries, half-up rules and quantity precision; validity policy and override authorization; local day/end-of-day/DST boundaries for each enabled zone; correlation validation. |
| API contract | V2 schemas, unknown fields, auth scopes, stable response/error envelopes, `201` vs `202`, idempotency behavior and document access. Freeze OpenAPI as the consumer contract. |
| PostgreSQL integration | Fresh DB and upgrade path; constraints; transaction boundaries; least-privilege runtime role; sequence allocation under concurrency; audit/outbox atomicity; migration head/readiness. |
| Migration | Apply all migrations from empty DB; upgrade from V1 snapshot; preserve IDs, numbers, data, documents and event hashes; test rollback using restore, not production `down`. |
| Idempotency | Concurrent same-key/same-payload; same-key/different-payload conflict; cross-principal isolation; durable lookup; retention/tombstone; retry after timeout and replayed terminal result. |
| Crash/retry | Kill process before DB commit, after issue intent commit, during PDF render, after deterministic file write before manifest commit, after manifest commit before HTTP response, after email provider accepts before delivery result commits. Verify one logical quote and honest unknown email outcome. |
| PDF | Compare amount/tax/shipping/customer/date fields to canonical snapshot; assert local Chile date and no UTC ambiguity; verify immutable bytes/hash over replay, expiry, cancellation and renderer upgrade. |
| Email | Use a fake sender only; queue/replay/recipient snapshot/attachment hash/retry/fencing/dedupe/unknown acceptance; no real Gmail in automated suite. |
| Expiry | DB clock at before/equal/after exclusive boundary; scheduler down then catch up; idempotent event; cancel-vs-expiry race; DST calendar-day cases. |
| Unknown outcome | Drop response after owner commit and prove GET-by-key/replay returns same quote. Missing lookup result must not cause blind duplicate create. |
| Failure injection | DB refused, connection timeout, bad credentials, DB recovered, schema stale, migration lock, disk full/read-only, PDF renderer crash, worker SIGKILL, stale lease/fencing, Gmail 429/5xx/timeout and ambiguous provider acceptance. |
| Existing suites | Preserve and extend current unit/integration test suites; filenames demonstrate current coverage seeds (`QS: test/unit/domain-quote.test.ts:1`; `QS: test/integration/quote-runtime.integration.test.ts:1`; `QS: test/integration/quote-persistence.integration.test.ts:1`; `QS: test/integration/migrations.integration.test.ts:1`; `QS: test/integration/readiness.integration.test.ts:1`; `QS: test/integration/quote-documents.integration.test.ts:1`; `QS: test/integration/quote-email-runtime.integration.test.ts:1`). |

## W. Production readiness checklist

- [ ] PostgreSQL database/network/backup/restore are provisioned and verified.
- [ ] Migration head and schema validation are deterministic; migration and runtime roles are separated.
- [ ] PM2/system supervisor has capped restart/backoff and alerts; DB outage yields live process + unready status.
- [ ] Service survives dependency recovery without manual restart; startup and runtime DB failures are diagnosable.
- [ ] V2 API and OpenAPI contract are frozen; all deployed consumers inventoried; V1 retirement plan is executable.
- [ ] Idempotency key scope, payload conflict, direct lookup, operation status, lease expiry and process crash recovery pass PostgreSQL integration.
- [ ] Default validity duration is signed by commercial owner; Chile date boundary, zone, DST, PDF and expiry scheduler tests pass.
- [ ] `opportunityId` is no longer required; generic correlation is queryable.
- [ ] Structured shipping snapshot preserves carrier/service/destination/amount/tax semantics.
- [ ] Customer snapshot supports guest/person/company without CRM identity and PII access controls.
- [ ] Issued PDF is immutable, authorized, backed up, recoverable and hash-verified.
- [ ] Email remains a separate explicit operation; no automatic email on issue; queue and unknown delivery are observable.
- [ ] Service authentication, network restriction, secret rotation and PII redaction are verified.
- [ ] All §V tests pass; migration restore rehearsal and failure injection results are recorded.
- [ ] Read-only production smoke verifies liveness, readiness, V2 read/list and existing document read without returning PII.
- [ ] After operational approval, a controlled synthetic create-and-issue canary runs with an internal synthetic customer, no email, no customer notification and an approved cleanup/retention path.
- [ ] No R4 integration is declared ready from health status alone.

## X. R4 readiness gate before J3B

All items must pass before J3B begins:

1. Quote Service production process is stable for at least seven consecutive monitored days, with zero unplanned restart and no stuck issuing operation; dependency recovery is demonstrated.
2. Database is provisioned, backed up/restorable, migrated deterministically and accessible with least-privilege runtime credentials.
3. V2 contract is frozen and published; deployed CRM callers and real data are inventoried; V1 retirement is scheduled.
4. Same execution key creates at most one quote; fingerprint conflict is deterministic; direct idempotency lookup and unknown outcome recovery require no consumer DB access.
5. Validity policy is owner-configured, versioned, signed off, computed at issue and rendered with explicit Chile-local inclusive date / exclusive instant / DST semantics.
6. `opportunityId` is no longer required; generic correlation is queryable.
7. Commercial snapshot is caller-resolved Model B; product price/tax semantics are frozen; arithmetic rules and CLP outputs match Quote.
8. Shipping metadata preserves carrier, service type when available, commune, amount and tax basis without a Quote-to-Shipping call.
9. Customer snapshot supports guest/person/company without CRM identity.
10. PDF generation, immutable artifact access, repair and expiry tests pass.
11. Email is a distinct explicit operation and cannot be triggered automatically by issue.
12. All §V tests, failure injection and migration restore rehearsal pass.
13. Read-only production smoke passes. A controlled synthetic mutation canary is separately approved and passes with no external email or customer side effect.
14. R4 adapter and fixtures reflect owner behavior; R4 production profile keeps Quote unavailable until the owner gate passes. `quote.create` remains `REQUIRE_APPROVAL` until an explicit R4 policy decision. ADR-029’s Sales v1 profile declares Quote unavailable and `quote.create` approval required (`R4: docs/adr/ADR-029-governed-production-channel-delivery-rollout.md:130-136`), while the current capability definition says `approvalPolicy: none` (`R4: agents/sales/src/capabilities/quote.ts:67-78`). Verify composed production policy actually enforces the ADR and resolve that metadata drift before enabling writes.

This is an owner readiness gate, not authorization to advance the R4 roadmap.

## Y. Recommended implementation slices

1. **Owner decisions and inventory:** validity default duration, enabled time zones/issuer profiles, tax presentation review, discount adjustment need, customer PII retention, actor scopes, storage topology, live/backups/data/caller inventory.
2. **Runtime/bootstrap reliability:** liveness/readiness split, sanitized DB diagnosis, schema-head check, controlled boot degradation, supervisor restart cap, migration/runtime role separation and restore runbook.
3. **V2 data contract and migrations:** generic external correlation, customer/shipping snapshots, validity policy stamp, clean state model, preserve existing rows/artifacts/audit data.
4. **Idempotent issuance operation:** create-and-issue plus manual draft path, immutable request/fingerprint, `issuing` lease/fencing, direct lookup, operation read, recovery at each crash window.
5. **Canonical arithmetic and validity:** publish CLP rounding, tax basis, adjustment treatment, owner policy and Chile-local inclusive end date.
6. **PDF and expiry:** correct templates, immutable artifact/hash path, pinned renderer repair, reliable expiry catch-up and API status projection.
7. **Explicit delivery:** harden email outbox and ambiguous outcomes; keep provider adapter optional; no auto-send.
8. **Security/observability/tests:** caller scopes, document auth, secret handling, PII redaction, event catalog and §V coverage.
9. **Cutover:** data restore rehearsal, controlled migration, V1 retirement, read-only smoke, then separately approved synthetic mutation canary.
10. **R4 contract update after owner is ready:** replace fixture pricing assumptions with frozen snapshot behavior; add real V2 HTTP adapter; reconcile using owner lookup; retain R4 approval policy until explicitly changed. This slice belongs to a later authorized R4 milestone.

## Z. Blockers and unresolved decisions

### Hard blockers

- **Production PostgreSQL and service availability:** observed DB unavailability is the direct outage cause (OPS). Production configuration and PM2 policy were not available as repository files; verify them during owner remediation.
- **V2 policy decision:** commercial owner must select default validity duration. Existing five-day text is not enough evidence to hard-code it.
- **Data inventory:** host DB was unavailable. Inspect live backups and artifact storage before declaring zero legacy data or applying a destructive schema change.
- **R4 policy drift:** production ADR-029 states `REQUIRE_APPROVAL`, while the capability metadata says `approvalPolicy: none`. Verify runtime composition and preserve approval until an explicit decision.
- **V2 contract and migration:** no live Quote Service adapter is documented in R4 (`R4: adapters/domains/src/quote/port.ts:19-20`); J3B cannot begin from the current fixture contract.

### Decisions to close before implementation

- Which issuer/market zones are enabled: Santiago only or Chile-wide including regions/islands with different IANA zones. Validity should follow the issuer policy, not delivery commune.
- Whether discounts are needed in V2. Default recommendation: Quote computes none; accept only explicit resolved adjustments if a caller can state tax allocation.
- Whether customer acceptance needs an attributed event. Default recommendation: no accepted quote status; retain customer response outside quote lifecycle or as a separately governed event if there is a real consumer.
- Whether persistent local document storage and one worker host meet required availability. Keep current storage until a demonstrated multi-host need justifies object storage.
- Who may override validity, cancel quotes, inspect PII, retrieve documents and re-drive unknown email delivery.
- Whether email is an owner capability or should later move to a general notification owner. Keep the current explicit outbox boundary for V2; do not couple it to issue.
- Tax labels and tax-basis names require finance/accounting review; this architecture defines arithmetic ownership, not legal tax advice.

## Source references

- Quote Service technical design and runtime code: `E:\dev\codex\MS\MS-pesaschile-quote-service` @ `fade75d`.
- Existing J3A code/production evidence summary: `docs/architecture/R4-J3A_QUOTE_OWNER_AUDIT.md`.
- R4 current contract and Sales capability: `adapters/domains/src/quote/port.ts`, `agents/sales/src/capabilities/quote.ts`, `docs/adr/ADR-029-governed-production-channel-delivery-rollout.md`.
- Time-zone source: [IANA Time Zone Database](https://www.iana.org/time-zones), [IANA South America tzdb source](https://data.iana.org/time-zones/tzdb/southamerica).
