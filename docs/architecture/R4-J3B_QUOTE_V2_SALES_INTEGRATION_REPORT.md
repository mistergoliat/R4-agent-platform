# R4-J3B — Quote V2 Sales Integration Report

Date: 2026-10-08 · Scope: R4-J3 Quote V2 Sales integration without harness modifications · Status: **PARTIAL** (source and offline evidence complete; EC2 run not authorized)

Evidence is labelled by where it comes from:

- **SOURCE**: code in this working tree.
- **OFFLINE**: automated tests with fixtures or mocks.
- **LOCAL-OWNER**: the real Quote V2 service (the owner's own `dist/` in its pinned Node 24 image) run on this workstation.
- **EC2**: the deployed integration host. **No EC2 command was executed in this slice.**

---

## A. Git baseline

| Repository | Ref | State |
|---|---|---|
| R4-agent-platform | `main` @ `aa974b7` | Pre-existing local changes not made by this slice: `.claude/settings.json` (modified) and `docs/architecture/R4_CRM_LEGACY_DEPENDENCY_DECOMMISSION_AUDIT.md` (untracked). J3B changes are uncommitted and await owner review. |
| MS-pesaschile-quote-service | local `HEAD` `686a0f6` (R1.7B-G2 closure commit; its PR/merge may still be pending) | Deployed release on EC2: `6735352` (R1.7B-G1 §W). No source change. Working tree unchanged apart from a pre-existing untracked review doc. `dist/` (gitignored) was rebuilt locally for the LOCAL-OWNER run. |
| Contract | `docs/v2/openapi.yaml`, OpenAPI `2.0.0` | sha256 `88b6b4b23ea9c31fde3698de45f064c6159f92f8c6506cd1d209dee2812c20d5` |

Historical J3A blockers (no V2 contract, owner-side pricing, no idempotency lookup) no longer apply: Quote V2 is Model B, has `expectedTotals`, an idempotency lookup and an operation resource. The current contract above is the reference, not the J3A findings.

## B. Change map (permitted paths only)

**Quote domain port and adapters**

| Path | Change |
|---|---|
| `adapters/domains/src/quote/v2.ts` | **New.** Quote V2 port (`QuoteV2Service`), wire types and the owner's normative arithmetic (§6.3, exact BigInt integers). |
| `adapters/domains/src/quote/fixture-v2.ts` | **New.** `FixtureQuoteV2Service`, an offline owner with V2 semantics. |
| `adapters/domains/src/index.ts` | Exports the two modules above. |
| `adapters/domains/quote/http/**` | **New package** `@r4-adapters/quote-http`: `config.ts`, `schemas.ts`, `client.ts` and owner examples copied verbatim into `fixtures/` (with `SOURCE.json`). |

**Sales capability and wiring**

| Path | Change |
|---|---|
| `agents/sales/src/capabilities/quote-v2.ts` | **New.** `quote.create` **version 2**: same capability id, same gateway. |
| `agents/sales/src/workspace/store.ts` | Quote V2 record methods on the existing Sales store. |
| `agents/sales/migrations/0007_sales_quote_v2_issuance.sql` | **New** migration, Sales-owned schema `sales` only. Not a generic R4 migration. |
| `agents/sales/src/production/profile-v4.ts` | **New.** `sales-production@4` = v3 + Quote REAL. The profile registry moved here to avoid an import cycle. |
| `agents/sales/src/production/profile-v3.ts` | Registry removed. The v3 profile object is unchanged and its fingerprint is still pinned by the existing test. |
| `agents/sales/src/production/{composition,bootstrap,control,index}.ts` | Quote binding and registry import path. |
| `agents/sales/src/cli/production.ts` | `R4_QUOTE_*` binding for the worker and plan. |
| `agents/sales/src/cli/quote-v2-e2e.ts` | **New** isolated synthetic runner. |
| `agents/sales/src/index.ts` | Exports. |

**Workspace registration and configuration**

`package.json` (workspace entry and `sales:quote-v2:e2e` script), `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `agents/sales/{package.json,tsconfig.json}`. These are the same entries `shipping-http` has.

**Tests**

- New: `tests/unit/quote-v2/*`, `tests/contract/sales-quote-v2.test.ts`, `tests/integration/sales-quote-v2.test.ts`.
- Updated:
  - `tests/contract/sales-boundaries.test.ts`: allow-lists for the new package and migration, plus the same no-domain-truth and no-runtime-reference checks applied to 0007.
  - `tests/contract/sales-profile-v{2,3}.test.ts`: `@4` is now a real profile, so the "nonexistent profile" sentinel became `@9`, and the registry lists v4.
  - `tests/integration/sales-reference.test.ts`: applied migrations list.
  - `tests/integration/live-ops-hardening.test.ts`: reads each table's schema from `information_schema` instead of a hardcoded Sales table list.

**Documentation:** this report.

## C. Harness proven unchanged

`git diff --stat HEAD -- packages apps adapters/channels adapters/models adapters/domains/catalog adapters/domains/shipping adapters/domains/src/{catalog,shipping,shared} agents/sales/sales.agent.json agents/sales/sales.v4.agent.json agents/sales/migrations/0006_sales_reference_application.sql` returns **empty**, and `git status` shows nothing under these paths.

Excluded (frozen) paths, all untouched:

- `packages/agent-kernel`, `context-compiler`, `task-runtime` (lifecycle, execution and recovery semantics), `policy-engine`, `capability-runtime` (gateway, `ActionExecutor`), `contracts`, `persistence-postgres`, `live-ops`, `model-gateway`, `observability`, `evaluation`, `shadow`, `agent-registry`.
- `apps/*`, including `worker`, `scheduler`, `channel-gateway` and `api`.
- `adapters/channels/whatsapp-cloud` (WhatsApp transport).
- The Sales agent definitions v3 and v4 (prompt and governance).

Capabilities the slice relies on that already exist:

- `registerWrite` versioning.
- `reconcile_before_retry`, where `unknown` leads to reconcile, then `needs_reconciliation`, then scheduler-dispatched reconcile.
- Approval by `argumentsMatch`.
- `approvalPolicy: 'required'`.

No extension point was missing for the slice itself. One missing point is noted in R-3.

## D. Quote V2 contract mapping

| R4 port | Owner route | Scope |
|---|---|---|
| `createAndIssue(body, key)` | `POST /v2/quotes` (`Authorization: Bearer`, `Idempotency-Key`, `Content-Type: application/json`, optional `X-Correlation-Id`) | `quotes:create` |
| `getQuote(id)` | `GET /v2/quotes/{quoteId}` | `quotes:read` |
| `getOperation(id)` | `GET /v2/operations/{operationId}` | `quotes:read` |
| `lookupIdempotency(key)` | `GET /v2/idempotency/current?operation=quote.create_and_issue` | `quotes:read` |
| `getDocument(id)` | `GET /v2/quotes/{quoteId}/document` | `quotes:document:read` |

No draft, issue, cancel, list, audit, email-delivery or `validityOverride` route is reachable. A contract test pins the exact route set.

`externalCorrelation = { sourceSystem: "r4-sales", externalReferenceType: "r4-task", externalReference: <taskId> }`. It identifies R4 and the conversation task, never a CRM opportunity, and it is never the idempotency authority. Validity is the owner's (`cl-retail-5-calendar-days-v1`). R4 computes no dates and never sends an override.

## E. CommercialSnapshot construction

The harness approves the proposal's validated arguments, and `execute` receives exactly those arguments. The approved facts therefore live in the `quote.create@2` input:

- the customer snapshot (owner kinds guest, person or company; nothing fabricated);
- per line: Catalog sellable-item key, quantity, the tax-included unit price and the tax rate;
- the chosen shipping offer (carrier, service, owner NET amount, `excluded`, `"0.19"`, destination commune), or `null`;
- `expectedTotals` (net, tax, gross);
- `currency: "CLP"`;
- `workspaceVersion`.

The schema is strict: no quote id, number, URL, idempotency key or unknown member is accepted.

On the **first** attempt, `execute` verifies every fact and sends nothing on any difference:

1. The workspace is at `workspaceVersion`, and the lines are exactly the workspace selection.
2. Catalog `getItemContext(itemKey, quantity)` returns `found`, `sellable`, enough stock, owner freshness not expired, pricing available, the same quantity tier, `finalGross` equal to the approved unit price, and a matching rate.
3. Shipping: a fresh order-basis `shipping.quote` contains the same carrier and service at the same NET, with a matching VAT rate. The destination must match the workspace delivery.
4. The owner arithmetic over the built body equals `expectedTotals`.

Then the **exact** `CreateQuoteRequest` is frozen in `sales.quote_v2_requests` with its SHA-256. Every later attempt (retry, replay or after a restart) sends that frozen body with no re-verification and no repricing. Changed commercial facts need a new proposal, which means a new approval and a new execution key.

## F. Catalog J1 provenance

| Request field | Source (Catalog item context for the approved key and quantity) |
|---|---|
| `item.sourceSystem` | `catalog-service` |
| `item.productRef` / `variantRef` | `ref.productId` / `ref.variantId` (variantRef omitted when null) |
| `item.sku` | `variant.sku ?? parentProduct.sku` |
| `item.description` | `parentProduct.name` |
| `item.attributes` | `variant.attributes` as `{group → name, value}` |
| `unitPrice` | `{ amount: pricing.finalGross.amount, taxBasis: "included", taxRate: canonical(pricing.tax.rate) }` |
| `pricingProvenance` | `{ sourceSystem: "catalog-service", reference: pricing.engineVersion, asOf: freshness.asOf }` |

Product-level "from" prices are never used. Text that cannot be printed under the owner's `Text` rules is refused (`catalog_text_unusable`), never rewritten.

## G. Shipping J2 mapping

| Request field | Source (fresh order-basis `shipping.quote`, offer matching carrier, service and NET) |
|---|---|
| `carrier.name`, `serviceType.name` | `offer.carrierName`, `offer.serviceType` |
| `destination` | `{ commune: destination.communeName, region: destination.regionName, country: "CL" }` |
| `amount` | `{ amount: offer.price.ownerNet.amount, taxBasis: "excluded", taxRate: "0.19" }` (owner contract §16: NET freight is sent as excluded 0.19) |
| `sourceQuote` | `{ sourceSystem: "pc-carrier", reference: provenance.endpoint, asOf: quote.asOf }` |

- A destination in the workspace with `shipping: null` is refused (`shipping_not_selected`). Shipping with no destination is refused (`shipping_without_destination`). A different commune is refused.
- The J2 port selects no offer. The customer's choice is the one recorded in the approved proposal (see R-2).
- The J2 gross (`round-half-up(net × 1.19)`) equals the Quote owner's excluded arithmetic, so totals are consistent.

## H. ExpectedTotals consistency

- `quoteV2ChargeAmounts` and `quoteV2Totals` implement §6.3 exactly with BigInt micro-units and `halfUp(n, d) = floor((2n + d)/(2d))`. This is not a pricing engine: it only verifies the owner's published arithmetic.
- **OFFLINE:** reproduces the owner's worked example (123 612 / 23 486 / 147 098), each line's amounts in `create-and-issue.response-201.json`, plus rounding, exempt and excluded cases.
- **LOCAL-OWNER:** the real owner computed totals identical to R4's for both the E2E snapshot (189 119 / 35 933 / 225 052) and a fractional-rounding probe (25 213 / 4 790 / 30 003).
- R4 always sends `expectedTotals`. An R4-side mismatch is refused before sending (`expected_totals_mismatch`, with the computed totals in the details). An owner `422 arithmetic_mismatch` is a refusal (`quote_arithmetic_mismatch`), never an outage. **LOCAL-OWNER** confirmed a 422 with typed expected and computed values, and nothing bound.

## I. Approval and governance

- The production action policy is unchanged: `SALES_PRODUCTION_ACTION_POLICY`, `quote.create: require_approval`, minimum identity provisional, evidence required.
- Defense in depth: `quote.create@2` declares `approvalPolicy: 'required'`, so even the autonomous reference policy yields `require_approval` (contract test).
- The policy engine allows only with an approval whose `argumentsMatch` holds. A mismatch is denied as `approval_scope_mismatch`.
- `ActionExecutor` never calls the handler without an ALLOW decision (`command_not_authorized`, zero owner calls; contract test). A rejected approval therefore issues nothing. The generic approve and reject flows are already covered by `tests/integration/human-collaboration.test.ts`, which is unchanged.
- No prompt, runtime governance or definition change. No forced tool selection, no fixed dialogue. The model can only propose.

## J. Adapter implementation

`QuoteV2HttpClient` (`bindingKind: 'http'`):

- Base URL, token and timeout come from `R4_QUOTE_*` (fail-closed loader). Non-loopback requires `R4_PROD_ALLOW_NETWORK=true` and https.
- Bounded deadline (`AbortSignal.timeout` combined with the caller's signal).
- Zod validation of every response. Non-strict objects, because the owner says unknown response members are ignored. Closed enums. 202 must agree with an `issuing` status.
- Size limits. A PDF must be `application/pdf`.
- Typed errors carry owner codes and only scalar, non-PII details.
- Telemetry carries no token, idempotency key, body or customer data (unit test).
- No PostgreSQL or document-volume access. No public endpoint needed.

Mutation outcome mapping: see the table in `client.ts`. In short:

| Owner answer | Classification |
|---|---|
| 400 / 413 / 422 | validation (refusal) |
| 401 / 403 | unauthorized (fail closed) |
| 409 | conflict with the owner code (`idempotency_key_conflict` is distinct from lifecycle codes) |
| 500 / 503, a reset after sending, an unreadable body after the status line, or a deadline | unknown outcome |
| Connection never established (`ECONNREFUSED` and similar) | temporarily unavailable, nothing sent |

Composition: `sales-production@4` registers `quote.create@2` only with an `http` Quote binding and REAL Catalog and Shipping. Otherwise it refuses to compose. v1–v3 never register Quote.

## K. Idempotency and reconciliation

- `Idempotency-Key` = the platform execution key (`r4x_` + 32 hex). The same key, principal and frozen body are used on every attempt. A new key is never generated for the same command.
- Before every POST, a row is appended to `sales.quote_v2_sends`.
- `settle()` decides success from the owner's state, never from the HTTP status alone:

| Owner state | R4 outcome |
|---|---|
| `issuing` | `unknown`; acceptance (quote id, number, operation) persisted in `sales.quote_v2_acceptances` |
| `issuing` with a failed operation | `unknown` with an operator message: no false success, no second quote (R-5) |
| `issued` | `applied`, only if number, issuance, `validity.source=policy`, document manifest, owner totals equal to approved, correlation, line count and shipping presence all match. Otherwise `unknown`. |
| `cancelled` and never issued | `failed` |

- `reconcile`:
  - frozen record absent → `not_applied`;
  - `lookupIdempotency` bound → get quote and operation → `settle`;
  - `not_found` → `not_applied` only when never sent, or when the last send started at least capability timeout + 30 s ago (owner §3.3), using the database clock. Otherwise `unknown`.
- 409 `idempotency_key_conflict` → `rejected` (`quote_idempotency_key_conflict`). 409 lifecycle → `rejected` (`quote_<owner code>`).
- **LOCAL-OWNER:** replay → `201 Idempotent-Replay: true`, same quote. Same key with a changed body → `409 idempotency_key_conflict`. Lookup by key → bound to the same quote. **The owner's request fingerprint equals R4's canonical-JSON fingerprint** (`42d7c1ea…`), and the fixture also reproduces the fingerprint in the owner's published `idempotency-lookup.bound.json` byte for byte (`c6b18e86…`).

## L. PDF integrity and read boundary

- After `issued`, R4 reads `GET /v2/quotes/{id}/document` with the R4 token and compares SHA-256 and byte length with the owner manifest and `X-Document-Sha256`.
- `verification` is `verified`, `mismatch` (bytes differ) or `unavailable` (read failed). The quote stays issued in every case and no duplicate is created.
- Persisted in `sales.quote_v2_issued`: quote id and number, issued-at, validity dates, `pdf_sha256`, `byte_length`, `document_verification`. No totals copy: the owner remains authoritative.
- The agent receives the hash and verification status only: no URL (never `127.0.0.1`), no bytes.
- No R4 renderer, no WhatsApp send, no Gmail call.
- **LOCAL-OWNER:** 31 869-byte PDF, `verified`.

## M. Fixture parity

`FixtureQuoteV2Service` does only what the owner does:

- binding of (key → fingerprint) with JCS-style canonical SHA-256;
- `expectedTotals` verification (422 `arithmetic_mismatch`) and `validation_error` for a person or company without a name;
- 201 / 202 issuance with operations (`completeIssuance(succeed|fail)`);
- a failed operation leaves the quote `issuing` with no document (409 `document_not_available`);
- the Chile 5-calendar-day validity, which reproduces the owner example exactly (2026-10-04 → through 2026-10-08, `validUntilExclusive` 2026-10-09T03:00:00Z);
- an immutable hashed PDF;
- fault switches: lost answer, timeout, outage, 401/403, corrupt or unavailable document.

It never prices, reads Catalog or Shipping, or emails (a contract test pins its public surface). The V1 `FixtureQuoteService` and `ShadowQuoteService` remain for the R4-F reference and R4-H shadow compositions only (R-6).

## N. Offline tests

New tests (49):

| File | Project | Tests | Covers |
|---|---|---:|---|
| `tests/unit/quote-v2/owner-contract.test.ts` | unit | 10 | arithmetic, fixture parity, fingerprint parity |
| `tests/unit/quote-v2/http-client.test.ts` | unit | 10 | HTTP mapping, headers, telemetry, config |
| `tests/contract/sales-quote-v2.test.ts` | contract | 8 | profile v4, availability, routes and scopes, approval, schema, no side-effect dependencies |
| `tests/integration/sales-quote-v2.test.ts` | integration (PostgreSQL) | 21 | the scenario matrix below |

Scenario coverage (offline test matrix, items 1–30):

| # | Scenario | Test |
|---|---|---|
| 1, 4, 7 | issue, tax included, shipping from the selected offer | S01 |
| 2 | Catalog mapping, variant identity | S02 |
| 3 | quantity tier | S03 |
| 5 | tax excluded or exempt (arithmetic in unit tests; products are tax-included, so a different treatment is refused) | S05 + unit |
| 6 | CLP rounding | unit |
| 8 | shipping requested but not selected | S08 |
| 9 | changed or stale evidence (price, stock, shipping NET, unknown carrier, selection, workspace version, owner freshness) | S09 |
| 10 | missing customer fields | S10 + contract |
| 11 | expectedTotals mismatch (R4 side and owner 422) | S11 |
| 12 | idempotent replay | S12 |
| 13 | same key, changed payload | S13 |
| 14–16 | 202 pending, then issued, or failed | S14/15, S16 |
| 17 | lost response after commit | S17 |
| 18 | timeout, same-key reconciliation and the 30 s rule | S18 |
| 19 | 401 / 403 | S19 |
| 20 | 409 / 422 | S13, S20, S11 |
| 21 | owner unavailable | S21 |
| 22 | PDF SHA-256 mismatch | S22 |
| 23 | PDF unavailable | S23 |
| 24, 25 | approval enforcement | contract |
| 26 | disabled configuration | contract |
| 27, 28 | no Gmail or WhatsApp dependency | contract |
| 29 | harness unchanged | §C diff |
| 30 | restart and recovery with a new pool, store and capability; append-only records | S30 |

Every integration test asserts the owner's committed quote count: **zero duplicate issuance, zero false success**.

Commands and results:

```
npx vitest run --project unit tests/unit/quote-v2                              → 20 passed
npx vitest run --project contract tests/contract/sales-quote-v2.test.ts        → 8 passed
npx vitest run --project integration tests/integration/sales-quote-v2.test.ts  → 21 passed
npm run lint && npm run typecheck && npm test                                  → exit 0:
    unit 937/937 · contract 286/286 · integration 357 passed, 12 skipped (0 failed) · sales 29/29 · shadow 5/5
npx vitest run --project recovery                                              → 1 pre-existing failure (below)
```

Known non-J3B results:

- `tests/recovery/production-bootstrap-process.test.ts` (`recovery` project, not part of `npm test`) expects `registered: sales@3`. The bootstrap registers every definition file, and `sales.v4.agent.json` exists since `50ec670` (J2D, 2026-10-03), after the test was last changed (`c75cc55`, 2026-10-01). It fails on the baseline too. Neither the definitions nor the bootstrap logic were changed here (only an import path).
- `tests/integration/worker-readiness.test.ts` (timing-sensitive) failed once under full-suite load and passes alone (18/18).

## O. Integration evidence beyond offline

**EC2: NOT RUN.** No R4 principal has been provisioned, and generating secret material on the host requires explicit authorization (§11), which this slice did not have. Nothing was executed on EC2.

**LOCAL-OWNER (not EC2):**

- Setup: the Quote repo's own `dist/` (rebuilt from `686a0f6`, no source change) ran in `node:24.14.0-bookworm-slim` (the owner's pinned renderer runtime), bound to `127.0.0.1:4020`. It used a throwaway PostgreSQL container and a local-only principal `r4-sales-local` with exactly `quotes:create`, `quotes:read` and `quotes:document:read`. The token existed only in a temporary file and the registry held only its hash. `QUOTE_EMAIL_PROVIDER=disabled`.
- `/health/ready` reported all five checks `ok`.
- `npm run sales:quote-v2:e2e`: **PASS**. Readiness 200, authenticated lookup of an unused key `not_found`, issue `201` `PC-000001` issued with totals 189 119 / 35 933 / 225 052, validity through 2026-10-12, PDF verified. Replay `201` replayed with the same quote. Reconcile `applied` with the same quote. The token appeared 0 times in the output.
- Probes: `422 arithmetic_mismatch` (nothing bound), `409 idempotency_key_conflict`, `401 unauthenticated`, `422 validation_error` for a person without `displayName`, and fingerprint parity (§K).
- Not exercised against the real owner: a 202 (issuance finished inside the 5 s budget) and 403.
- All containers and the throwaway databases were removed afterwards.

**Prepared EC2 procedure** (each step needs the authorization named):

1. *(Authorization: R4 principal provisioning.)* On the host, use the owner's rotation mechanism (`npm run principals:token`) to create principal `r4-sales-integration` with exactly the three scopes. Put only the hash in `principals.json` and reload with `kill -HUP`. No container restart. Store the token in R4's secret store.
2. Check connectivity and authentication: `curl -s http://127.0.0.1:4020/health/ready`, then the runner's authenticated lookup.
3. Run the runner from an isolated shell, not PM2, with a throwaway database:

   ```
   R4_QUOTE_MODE=real R4_QUOTE_BASE_URL=http://127.0.0.1:4020 R4_QUOTE_BEARER_TOKEN=<secret store> R4_QUOTE_TIMEOUT_MS=20000 R4_QUOTE_E2E_DATABASE_URL=<throwaway db> npm run sales:quote-v2:e2e
   ```

   It refuses a database that holds an R4 platform schema. It uses synthetic products and a synthetic guest, and makes no model, channel, rollout, Meta or PM2 change.
4. Record the JSON evidence in this report. Leave `sales-production@4` undeployed until separate authorization.

## P. Credential isolation

- The token comes from `R4_QUOTE_BEARER_TOKEN` only, validated as at least 32 printable characters. It is never in a URL (URL credentials are refused), never in `describeQuoteHttpConfig`, plan output, telemetry or test output (checked).
- R4 needs only its own principal with three scopes. It never uses the G1 test tokens, never asks for `read:any`, `quotes:validity:override` or `quotes:delivery:email`, and never accesses the Quote database or volumes.

## Q. Existing service impact

- No EC2 command, no PM2 restart, no rollout, allowlist or Meta change, no WhatsApp routing change, no CRM-Customer-360 change, no Quote source change, migration or deployment. No EBS or Docker change on EC2.
- Deployed profiles v1–v3 keep their frozen fingerprints, and v3 still runs Sales definition v4.
- **Deployment note:** once this code is deployed (even under v3), `production:sales:bootstrap` and `production:sales:control` refuse with `schema_not_current` until `npm run sales:migrate` applies `0007_sales_quote_v2_issuance`. Run it before any restart that picks up this code.

## R. Remaining limitations

1. **EC2 synthetic E2E not run**: it needs authorization for R4 principal provisioning (§O).
2. **Shipping selection is carried by the approved proposal**, not persisted in the workspace (the J2 port and workspace have no "selected offer" operation). The approver and a fresh owner re-quote guard it. A workspace selection operation would be a separate, bounded J2/workspace change.
3. **The model must compute `expectedTotals`.** A wrong value fails closed after approval, which wastes that approval. The generic gateway has **no pre-approval validation hook**. That is the precise missing extension point, and adding it is a harness change and was not made. A Sales-only READ "quote preview" capability (no harness change) is the recommended follow-up.
4. Descriptive fields (description, SKU, attributes, provenance `asOf`) are resolved from Catalog for the approved item keys at first execution and frozen. They are not shown to the approver; any commercial difference fails closed.
5. A failed issuance operation stays `unknown` until an owner operator retries or cancels the quote. This is deliberate: no false failure that could lead to a duplicate.
6. The R4-F reference harness and the R4-H shadow compositions still use the V1 port and fixtures. Production uses only V2. Migrating them is a separate evaluation and regression change.
7. `backorder` items are refused (only `sellable`). Customer address is not supported in the input. Document re-verification after `unavailable` is not automated.
8. Real-model behaviour with `quote.create@2` was not evaluated (no live eval run).

## S. R4-J3 readiness decision

The implementation is complete at source and offline level, and was validated against the real Quote V2 owner locally. The EC2 step is pending authorization. **Not ready for customer rollout.** Next gates: authorize R4 principal provisioning and the EC2 synthetic run, then owner review and commit, then a separate decision to deploy `sales-production@4`.

```
R4_HARNESS_MODIFIED=NO
R4_KERNEL_MODIFIED=NO
R4_POLICY_ENGINE_MODIFIED=NO
R4_GENERIC_GATEWAY_MODIFIED=NO
R4_QUOTE_V2_ADAPTER_IMPLEMENTED=YES
R4_COMMERCIAL_SNAPSHOT_VALIDATED=YES
R4_QUOTE_APPROVAL_ENFORCED=YES
R4_IDEMPOTENCY_RECONCILIATION=PASS
R4_QUOTE_CONTRACT_TESTS=PASS
R4_EC2_SYNTHETIC_E2E=NOT_RUN
R4_PRODUCTION_WHATSAPP_UNCHANGED=YES
QUOTE_SERVICE_UNMODIFIED=YES
GMAIL_PROVIDER_UNCHANGED=YES
R4_J3B_IMPLEMENTATION_STATUS=PARTIAL
R4_J3_READY_FOR_CUSTOMER_ROLLOUT=NO
```
