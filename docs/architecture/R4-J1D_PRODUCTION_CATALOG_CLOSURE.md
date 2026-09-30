# R4-J1D — Production Catalog Closure

Status: **IN PROGRESS — Catalog `47875d5` deployed and configured; Step 5 rerun: NOT_READY_FOR_R4 (pricing contradiction vs storefront, −1 CLP on 19/20 boundary discount units) → return to Catalog fix**
Date: 2026-09-30
Repos: `R4-agent-platform` + `MS-pesaschile-catalog-service`
Predecessors: R4-J1A (Catalog remediation), R4-J1B (R4 consumer), R4-J1C (contract convergence, R4 `c839688`, Catalog `cbe4ac6`).

---

## 1. Executive verdict

**R4-J1 Catalog — NOT CLOSED.**

Everything that can be closed without touching production is closed and verified:
the three owner semantic decisions (OD-1..3) are decided, implemented, tested and
published in the owner contract; the five mandatory Catalog fixes (J1D-CAT-01..05)
are implemented and pass unit, contract, HTTP and real-SQL (MariaDB) gates; Gold
Set v0 passes every hard class (and demonstrably fails on the J1C code it fixes);
R4 consumes the new contract with zero repair logic; all R4 gates pass.

What remains is, by design, gated on explicit authorization: the Catalog commit
(and its real SHA in R4 `SOURCE.json`), the read-only production queries B1–B9,
the Catalog deployment, the production smokes and parity sample, profile v2 on the
allowlist and the WhatsApp E2E. See §19.

## 2. J1 scope boundary

In J1: canonical product/item identity, lifecycle, price/tax/promotion semantics,
availability/backorder/sellability, meaningful category, specifications, owner
freshness, nominal search, schemas and owner fixtures — for `/v2/catalog/*` —
and R4's governed read-only consumption of them.

Not in J1 (CAT-V2, §17): conceptual discovery, projections, hybrid/vector
retrieval, composition, Human Browse API, legacy retirement.

Ownership held throughout: Catalog decides commercial truth; R4 decides when to
search/clarify/refresh and what to say. R4 never computes or repairs price,
promotion, sellability, category or freshness (verified, §9.6).

## 3. OD-1 outcome — `priceSummary.from`

**Decided and implemented (Catalog).** A unit is *commercially offerable* when its
sellability is `sellable` or `backorder` (orderable now, from stock or on
backorder). `check_with_staff` and `not_sellable` units are not offerable.

- `from` = minimum final price over **offerable** priced units only; a unit that
  cannot be ordered never lowers the advertised price.
- New required field `priceSummary.basis`: `offerable` | `not_offerable`.
- Explicit fallback: when no priced unit is offerable, the summary is the minimum
  over all priced units with `basis: not_offerable` (a reference price, never an
  offer). Applies to `exact` (simple product) too.
- Evidence: fixture `product-with-variants.json` moved from 119 000 (out-of-stock
  L variant) to 130 900 (in-stock XL); unit tests for cheaper-unorderable,
  backorderable-counts, and no-offerable fallback (`tests/unit/catalogV2J1D.test.ts`).
- R4: `basis` added to the port, schema and the model-facing price view; the
  `catalog.search` description tells the model `not_offerable` is never an offer.

## 4. OD-2 outcome — amount discounts

**Decided and implemented; contract shape changed before production.** The raw
PrestaShop row (`discountType` / `discountValue`, whose tax basis followed
`reduction_tax`) is no longer published. Promotion is now a normalized union,
present only when it lowers the price:

```
{ type: 'percentage', percentOff: 0<x≤1, amountOffGross: null,  validUntil }
{ type: 'amount',     percentOff: null,  amountOffGross: Money, validUntil }   // tax INCLUDED
```

`regularGross` is the unit price **before the reduction**, with a fixed-price
override (`specific_price.price ≥ 0`) already applied — PrestaShop's own "price
without reduction". A pure override is therefore the regular price, not an
invented discount, and `finalGross ≤ regularGross` always holds (R4's schema
already enforced it). `reduction_tax=0` and `=1` produce identical public answers
for the same economic reduction. Engine version `catalog-commercial-v2.1.0`.

Versioning decision: `schemaVersion` stays **1**. The J1C shape was never deployed
nor consumed in production; v1 is declared frozen at its first production
deployment (recorded in `contracts/catalog/v2/schemas/catalog-v2.schema.json`
`versionHistory`). Consumers pin by `engineVersion` + owner SHA.

## 5. OD-3 outcome — freshness

**Documented and tightened (Catalog owns; R4 bounds by owner, ADR-030).**
`freshness.validUntil = min(asOf + 15 s, first scheduled price change)`, where a
scheduled change is the applied row's end **or a compatible row's future start**
(new in J1D; previously only promotion end, and search answers had no price
bound at all — now all three surfaces carry it). The owner cache never serves an
entry at or after its `validUntil` (J1D-CAT-03). R4 records
`min(observedAt + 5 min, owner validUntil)` (ADR-030, unchanged) and never
lengthens owner validity. `asOf` remains the real read time on cache hits.

## 6. Catalog fixes applied

| Fix | Change | Main files |
|---|---|---|
| J1D-CAT-01 nominal search recall | Root cause: the normalized query (`kettlebell 20kg`) was sent as ONE `LIKE` phrase against raw names (`Kettlebell Acero 20 Kg`) → zero results for natural multi-token queries. Now: SQL retrieves exact reference/name, raw phrase, **every significant token in the name** or **in the short description** (measures by their number); the service applies a deterministic nominal matcher: `exact_reference > exact_name > phrase > all_tokens > description`, then word order, name closeness, name, id. Measures match exactly (`10 kg` ≠ `110 kg`); explicit equivalences only (case, accents, unit spellings incl. "kilos", singular/plural). No conceptual expansion. v1 ranking untouched. | `src/domain/catalog/v2/nominalSearch.ts`, reader, service |
| J1D-CAT-02 meaningful category | Production evidence: **all 1 550 current-catalog products have `id_category_default = 2 (CATEGORÍAS)`**, the navigation root. Category now comes from `category_product`, restricted to the audited SEMANTIC_STRONG/WEAK categories (strongest → deepest → lowest id); never root/campaign/legacy/test; `null` if none. Offline: 854/889 active products get a meaningful category; the 35 nulls are campaign/outlet-only or internal service lines. | `categoryTrustMap.ts` (generated, `scripts/catalog-v2/generate-category-trust-map.mjs`), `meaningfulCategory.ts`, reader |
| J1D-CAT-03 bounded cache | Unbounded `Map` → `BoundedTtlCache` (LRU, 500 entries default, `cacheMaxEntries`), per-entry expiry = the answer's own `validUntil`; normalized key (whitespace-collapsed, case-folded query + explicit filter tuple). | `boundedTtlCache.ts`, service |
| J1D-CAT-04 snapshot fail-closed | `catalogPresence` is required: a snapshot missing it is incompatible as a whole (no more `.default('historical_order_detail_only')`). Readers keep the previous valid snapshot on a failed refresh; at boot the capability stays `not_loaded` (503 on its own endpoints only). | `product-semantic-snapshot/contracts.ts` |
| J1D-CAT-05 capability-aware readiness | `/health/ready`: 503 `unavailable` only when commercial truth is down (DB, or Redis when it is the configured v1 cache); optional intelligence down → **200 `degraded`**. New `checks.capabilities {commercialTruth, relationships, productSemantics, trainingSemantics}`. Previously a missing relationship snapshot returned 503 and took the commercial API out of rotation. | `shared/readiness.ts`, `app.ts`, `server.ts`, `bootstrap.ts` |
| B7 preparation | Specific-price windows are read as text and converted from `PRESTASHOP_TIMEZONE` (IANA, DST-aware; default `UTC` = J1C behaviour) to real instants. The production value is decided by B7. | `shared/zonedTime.ts`, config, reader |

## 7. Gold v0 results

Set: `contracts/catalog/eval/gold-v0.json` (28 cases, production ids; expected sets
frozen from independent regexes over the export, not from the implementation).
Runner: `scripts/catalog-v2/evaluate-search-gold.ts` (offline, or `CATALOG_GOLD_BASE_URL`
for a deployed service). Gate test: `tests/contract/catalogSearchGoldV0.test.ts`.

| Class | Gate | J1D (offline, prod export) | J1C `cbe4ac6` (same set) |
|---|---|---|---|
| exact_sku | hard | 7/7, hit@1 100 % | 7/7 |
| product_name | hard | 4/4, hit@1 100 % | 4/4 |
| multi_token_nominal | hard | 4/4, recall@10 100 % | **1/4, recall 0 %** |
| unit_bearing | hard | 3/3, recall@10 100 %, 0 exclusion violations | **1/3, recall 20 %** |
| supported_synonyms | hard | 6/6 | **4/6, recall 0 %** |
| typo | measured | 0/4 (no fuzzy in v0) | 0/4 |

Deterministic ordering: yes (every case run twice). **GOLD v0: PASS.** No regression
in the strong exact classes. The J1C column proves the regression: `kettlebell 20 kg`,
`disco 10 kg`, `banco ajustable` returned **zero** results. The live (HTTP) gold run is
part of §12.

## 8. B1–B8 production evidence

**Executed 2026-09-30 — results in "Production Read-only Evidence — Step 2" below; this table is the pre-execution plan.** (SELECT-only account,
`docs/audits/r4-j1c-production-unknowns.sql`, extended in J1D). Dry-run on the local
kit: all statements parse; the only errors are tables the synthetic kit does not model.

| Item | What it proves | Status | Blocks |
|---|---|---|---|
| B1 schema (+ J1D `ps_category`, `ps_category_product`) | every reader column exists | UNKNOWN | deploy |
| B2/B3 tax rules on sellable products | `configured_flat_rate` 19 % is right | UNKNOWN | deploy |
| B4 specific_price reduction types / `reduction_tax` / fixed overrides | OD-2 inputs | UNKNOWN | deploy |
| B5 tie/specificity + `PS_SPECIFIC_PRICE_PRIORITIES` | engine tie-break = PrestaShop | UNKNOWN | deploy |
| B6 backorder / out-of-stock config | sellability derivation | UNKNOWN | deploy |
| B7 DB/session tz + `PS_TIMEZONE` | sets `PRESTASHOP_TIMEZONE`; expected CONTRADICTED vs UTC reading (fix already built, config-only) | UNKNOWN | deploy |
| B8 bounds (combinations ≤ 100, attributes ≤ 10, features ≤ 40, names) | contract bounds hold | UNKNOWN | deploy |
| B9 [J1D] default category, trust-map drift, categories per product | CAT-02 source still valid | UNKNOWN | deploy |
| D1 [J1D now blocking] collation `*_ci` accent-insensitive | CAT-01 token retrieval | UNKNOWN | deploy |

Rule: any CONTRADICTED result that affects commercial truth stops enablement → fix
Catalog → regenerate schema/fixtures → re-sync R4 → rerun affected gates.

## 9. Contract / fixture convergence

1. Catalog schema reference, 24 owner fixtures and `MANIFEST.json` regenerated from
   the real service (`CATALOG_V2_WRITE_FIXTURES=1`); manifest sha256
   `223b3550…c72e`.
2. Catalog committed (authorized J1D step 1): **`47875d5fe0f98f17c1d96863f02a5ed7e4195694`**.
3. R4 synced from that commit (`scripts/sync-catalog-fixtures.mjs`): MANIFEST byte-identical
   to the owner's; 24/24 fixture hashes verified with the declared canonical algorithm;
   manifest sha256 `223b3550…c72e`. No fixture edited by hand.
4. `SOURCE.json`: `ownerCommit: 47875d5f…`, **`ownerContractFilesUncommitted: false`**.
5. Cross-repo contract tests: R4 `contract` 229/229, owner fixture tests 8/8.
6. **R4 zero repair logic: verified.** Scan of `adapters/domains/catalog/http/src`,
   `adapters/domains/src/catalog` (excluding the in-memory fake owner), `agents/sales/src`
   and `packages` for owner-money arithmetic, tax, reduction, sellability derivation,
   root-category handling and freshness extension: no production-path hits (only
   evaluation fixture builders and descriptive strings). R4 maps owner fields 1:1.

## 10. Catalog tests

| Gate | Result |
|---|---|
| typecheck / build | PASS / PASS |
| lint (all touched files) | PASS |
| J1D unit (`catalogV2J1D.test.ts`, 22) + v2 service/reader | PASS |
| owner fixture contract (J1C/J1D) | 8/8 |
| Gold v0 gate | PASS |
| HTTP v2 endpoint | PASS |
| real SQL (MariaDB 11.4 kit, `PRESTASHOP_TIMEZONE=America/Santiago`) | PASS — see below |
| full suite (`--no-file-parallelism`) | 2 327 passed, 12 failed — exactly the 12 pre-existing (§10.1); 0 new |

Real-SQL smoke (built service → MariaDB kit): readiness 200 `degraded` with no
snapshots; `kettlebell 20 kg` / `KETTLEBELL 20KG` / `kettlebell 20 kilos` → only the
20 kg product (never 24 kg); `KH20`/`kh20` and variant SKU `BAR-20-XL` →
`exact_reference`; category `Barras Olímpicas` for a product also in `Test`; root-only
product → `null`; `from` = 130 900 `offerable`; zero-datetime promotion in the new
shape; far-future shop-local window neither applied nor bounding freshness.

### 10.1 Full suite and pre-existing failures

Pre-existing, verified before any J1D change (baseline run): 12 deterministic failures
in `getTrainingSemanticReadSurfaceEndpoint` (4), `queryTrainingSemanticsEndpoint` (4),
`semanticDiscoveryQueryEndpoint` (4) — they read the gitignored
`data/training-semantic-snapshots/v2`, absent on this machine. Unrelated to v2.

Intentional behaviour changes whose tests were updated (not weakened): 9 readiness
tests (optional snapshot no longer gates; `capabilities` added), 1 runtime-wiring test
(200 `degraded`), 1 snapshot-builder test (legacy snapshot now rejected instead of
defaulted), engine-version and SQL-shape assertions.

## 11. R4 tests

| Gate | Result |
|---|---|
| build / typecheck / lint | PASS / PASS / PASS (`--max-warnings=0`) |
| unit | 854/854 |
| contract (incl. owner-fixture compatibility, profile v2, v1 fingerprint pin) | 229/229 |
| integration | 318 passed, 6 failed in the parallel run, 12 skipped; the 6 are in `live-ops-hardening`, `live-ops-reference`, `production-control`, `worker-readiness` (no Catalog code) — **all 80 pass when rerun in isolation** (known timing sensitivity); the 12 skipped are the opt-in real-HTTP test, run separately below |
| real HTTP Catalog (`catalog-http-real.test.ts`, R4 adapter → built service → MariaDB; auth, 429, 503, hung-source deadline, contract violations) | 12/12 |
| sales | 29/29 |
| shadow | 5/5 |
| recovery | 16/16 |
| Catalog adapter / ADR-030 owner freshness | included in unit (PASS) |

R4 changes: `CatalogPriceSummary.basis`, `CatalogPromotion` union (port + HTTP
schema), fake owner mirrors OD-1, price views expose `basis`, two tests that pinned
the owner's old order now follow the owner fixture, profile-v2 freshness text.
Profile v1 fingerprint unchanged; profile v2 still not wired.

## 12. Production Catalog smoke

**PENDING (requires deployment authorization).** Plan: deploy Catalog only; verify
liveness/readiness and that optional intelligence can be degraded without taking
down commercial truth; then read-only cases — exact SKU, multi-token nominal, simple,
with variants, `variant_required`, item variant, promotion, zero stock, backorder,
inactive, not_found, meaningful category, specs, freshness, typed errors — checking
auth, correlation id, schema, latency and failure semantics; plus the live gold run:
`CATALOG_GOLD_BASE_URL=… CATALOG_GOLD_API_KEY=… npx tsx scripts/catalog-v2/evaluate-search-gold.ts`.

## 13. Storefront / PrestaShop parity sample

**PENDING.** 5–10 production products covering simple, variant, discount / no
discount, stock, backorder, inactive; compare price, variant identity, sellability,
stock/backorder and promotion window against PrestaShop/storefront. Specific checks
added by J1D: fixed-price override shows no strikethrough (OD-2 regular price);
promotion window boundaries in shop-local time (B7).

## 14. R4 → Catalog production smoke

**PENDING.** Adapter only (no agent reasoning): `search`, `getProductContext`,
`getItemContext` against production with the R4 key; auth, timeout, DomainError
mapping, schema, owner freshness, zero repair logic. The same checks pass against the
local kit (§11).

## 15. Allowlisted WhatsApp E2E

**PENDING.** Requires profile v2 enabled separately with `rolloutPercent=0` and an
explicit smoke-identity allowlist (profile v1 fingerprint unchanged), plus the Meta
credentials this environment does not have (R4-I external blocker). Conversations:
exact SKU, multi-token nominal lookup, price question, variant product, variant
clarification/selection, zero-stock/backorder.

## 16. Remaining non-blocking issues

- **Deploy consequence of CAT-04 (decide before deploying):** the product semantic
  snapshot in `data/product-semantic-snapshots` (schema 1, 2 011 records, built
  2026-08-29) has **no `catalogPresence` on any record**. If production holds the same
  snapshot, J1D makes product semantics / semantic discovery **unavailable** until it
  is rebuilt with presence. Commercial truth and `/v2/catalog/*` are unaffected
  (CAT-05). Options: rebuild the snapshot before deploying, or accept the degraded
  capability temporarily. **Resolved by Step 3:** the snapshot active in production
  (`a86a8c6f…`, built 2026-09-10) carries `catalogPresence` on 2 011/2 011 records and
  is compatible; the presence-less build is the older local/archived one.
- Typo tolerance absent (gold `typo` 0/4, measured).
- Search candidate retrieval has no row cap (correct ranking, latency to observe).
- Category trust map is a static generated snapshot; 35/889 active products → `null`.
- Search tie-break changed (closer name first); R4 follows owner order by contract.
- `docs/audits/r4-j1c-production-unknowns.sql` keeps its J1C filename; J1D items are marked.

## 17. Items transferred to Catalog Platform V2

The §10 deferred list (reproducible semantic extractor, projection manifest, hot
reload, Spec Projection, hybrid/vector retrieval, concept lexicon, `catalog.discover`,
role/capability projection, compatibility, `catalog.compose`, Human Browse API, CRM
migration, legacy retirement) is already owned by
`MS-pesaschile-catalog-service/docs/architecture/CATALOG_PLATFORM_V2_PRD.md`. The J1D
residuals were appended there as **Appendix J1D (H1–H6)**: typo tolerance, trust-map
versioning, semantic snapshot rebuild, retrieval bounds, single price engine,
conceptual equivalences.

## 18. Revisions / SHAs deployed

| Artifact | Revision |
|---|---|
| Catalog J1C baseline | `cbe4ac6` (committed, not pushed, not deployed) |
| Catalog J1D | `47875d5` (on `origin/main` per `git ls-remote`, 2026-09-30; not deployed; engine `catalog-commercial-v2.1.0`, manifest `223b3550…c72e`) |
| R4 J1C baseline | `c839688` (committed, not pushed) |
| R4 J1D | commit that contains this document (synced to Catalog `47875d5`; not pushed) |
| Deployed Catalog | `7a214f4` (2026-09-10, pre-v2: no `/v2/catalog/*`), PM2 `catalog-service` on EC2 (Step 3) |
| Deployed R4 profile | v1 (Catalog UNAVAILABLE); v2 not deployed |

## 19. Final closure gate

| Gate | State |
|---|---|
| **Contract** | |
| J1A/B/C complete | ✅ |
| J1D complete | ⏳ production steps pending |
| canonical product/item semantics stable | ✅ (identity unchanged since J1C; OD-1/2 shape frozen for v1) |
| owner fixtures synchronized | ✅ from Catalog `47875d5` |
| owner SHA recorded | ✅ `47875d5f…` (`ownerContractFilesUncommitted: false`) |
| cross-repo contract PASS | ✅ |
| R4 zero repair logic | ✅ |
| **Catalog truth** | |
| OD-1 resolved | ✅ |
| OD-2 resolved | ✅ |
| OD-3 documented | ✅ |
| nominal search regression fixed | ✅ (gold v0) |
| category meaningful | ✅ offline; ⏳ B9 confirms trust map in prod |
| cache bounded | ✅ |
| incompatible snapshots fail-closed | ✅ |
| readiness capability-aware | ✅ |
| **Production evidence** | |
| B1–B8 (+B9, D1) resolved read-only | ⏳ needs read authorization |
| no unresolved contradiction on commercial truth | ⏳ |
| tax / specific-price assumptions validated | ⏳ B2–B5 |
| backorder validated | ⏳ B6 |
| timezone validated | ⏳ B7 (fix ready, config-only) |
| **Deployment** | |
| Catalog v2 deployed | ⏳ |
| direct production read-only smoke PASS | ⏳ |
| representative parity PASS | ⏳ |
| R4 adapter → production Catalog PASS | ⏳ (PASS locally) |
| R4 profile v2 deployed separately | ⏳ |
| allowlisted WhatsApp E2E PASS | ⏳ (+ Meta credentials) |
| **Quality** | |
| owner fixture tests PASS | ✅ |
| cross-repo tests PASS | ✅ |
| search gold v0 PASS | ✅ offline; ⏳ live |
| no new relevant regressions | ✅ |
| **Documentation** | |
| J1D closure document complete | ⏳ this document, §8 and §12–15 to be filled with evidence |
| remaining Catalog evolution transferred to CAT-V2 PRD | ✅ Appendix J1D |

**Verdict: R4-J1 Catalog — NOT CLOSED. R4-J2 Shipping remains NOT ACTIVE.**

Step 1 (commit Catalog → sync → commit R4) done 2026-09-30. Next authorizations
needed, in order: (2) run the read-only production SQL; (3) decide the semantic-snapshot deploy
consequence (§16); (4) deploy Catalog only; (5) production smokes + parity;
(6) enable profile v2 on the allowlist; (7) WhatsApp E2E.

---

## Production Read-only Evidence — Step 2

Executed 2026-09-30, 16:19–16:23 UTC, under the Step 2 read-only authorization.
Environment: production PrestaShop database (MariaDB 10.6.25, PrestaShop 1.7.8.3), direct
connection with a dedicated account whose only privilege is `GRANT SELECT ON *.*`; every
session ran `SET SESSION TRANSACTION READ ONLY` + `START TRANSACTION READ ONLY` +
`max_statement_time = 30`; 0 rows affected; ~0.15 s per statement. Client: throwaway
`mariadb:11` container (note: the client did not verify the server TLS certificate).

Raw evidence (aggregates, configuration and category names only; no personal data, no
connection identifiers): `docs/audits/r4-j1d-step2/`
- `b1-b9-d1.sql` — verbatim lines 13–160 of Catalog `docs/audits/r4-j1c-production-unknowns.sql`
  @ `47875d5` (plus session timeout and `COMMIT`); output `b1-b9-d1.output.txt`.
- `supplemental-s1-s7.sql` / `.output.txt` — additional read-only aggregates for gaps the B
  definitions do not cover (S1 category coverage, S2 specific-price scope/ranges/overlap in
  shop-local time, S3 remaining text bounds, S4 timezone corroboration, S5 retrieval upper
  bound, S6–S7 multi-shop topology). They do not redefine B1–B9/D1.

### Read-only safety gate

Every statement of B1–B9 + D1 was reviewed before execution: SELECT / variable reads only
(READ_ONLY_SAFE); the session preamble and `COMMIT` are READ_ONLY_WITH_CAUTION (session
scope, read-only transaction). None NOT_AUTHORIZED; no statement adapted. The same review
and an automated keyword scan (no DML/DDL/DCL/locking/`INTO`) were applied to S1–S7.
D2–D9 were not run.

### B1–B9 + D1

| ID | Status | Impact | Evidence | Required action |
|----|--------|--------|----------|-----------------|
| B1 schema | CONFIRMED | NON_BLOCKING | 49/49 listed columns present with expected types (`ps_specific_price.from/to` datetime NOT NULL, `reduction_type` enum, `visibility` enum); PS 1.7.8.3. Every other reader column was exercised by B/S queries without error | none |
| B2 tax group distribution | CONFIRMED | NON_BLOCKING | 875/875 sellable products (active, visible, `available_for_order`) → `id_tax_rules_group = 1` | none |
| B3 effective tax | CONFIRMED | NON_BLOCKING | group 1 "CL Standard Rate (19%)": one rule, CL (68), all states/zips, rate 19.000, active; `PS_TAX=1`; `PS_PRICE_ROUND_MODE=2` (half-up) = engine `ROUND_HALF_UP` to integer CLP; Catalog `TAX_RATE` default 0.19 | keep `TAX_RATE` unset/0.19 on deploy (deployed value not yet read) |
| B4 specific_price shapes | CONFIRMED | NON_BLOCKING | all 227 current/future rows: `percentage`, `reduction_tax=1`, no fixed-price override, no customer/group/currency/country/combination/quantity scope, no catalog rule; 203 all-shops + 24 shop-scoped. S2b: percentages 0.10–0.80. Expired history also has 137 `amount` rows and fixed overrides — both already supported (OD-2) | none |
| B5 ties / priorities | CONFIRMED | NON_BLOCKING | no tie in the public context (empty set); S2c: 0 products with >1 applicable public row across `id_shop` 0/1 in shop-local time; `PS_SPECIFIC_PRICE_PRIORITIES = id_shop;id_currency;id_country;id_group` = engine order after combination | none |
| B6 out_of_stock / backorder | CONFIRMED | NON_BLOCKING | `PS_ORDER_OUT_OF_STOCK=0`, `PS_STOCK_MANAGEMENT=1`, advanced stock 0; per-row `out_of_stock` ∈ {0 deny, 2 use global → deny}, never 1 → no product is backorderable. Catalog applies 1/0 per variant, else the global → identical outcome; 0 simple products without a stock row | none |
| B7 timezone | CONTRADICTED (the default `UTC` reading); value established | BLOCKING until configured (config only) | DB `@@global`/`@@session.time_zone = UTC`; `PS_TIMEZONE = America/Santiago` (global, no shop override). S4: latest PHP-written `ps_connections`/`ps_cart.date_add` = 13:22 while DB UTC = 16:22 → PrestaShop writes shop-local time at UTC−3 (Chile DST since 2026-09-06). Window times such as 23:45 / 15:30 are admin local entries | deploy with `PRESTASHOP_TIMEZONE=America/Santiago` (not set in this step) |
| B8 contract bounds | CONFIRMED | NON_BLOCKING | combinations ≤ 6 (limit 100), attributes per combination 1 (10), features ≤ 37 (40), names 1..84 (128), feature values ≤ 255 (255), 0 empty; S3: SKU ≤ 16 (64), brand ≤ 16 (64), feature/attribute/category names ≤ 38 (128) | none (features 37/40 is close — watch) |
| B9 category | CONFIRMED | NON_BLOCKING | `id_category_default = 2 (CATEGORÍAS)` for 885/885 active visible products; trust map vs production: 0 ids missing, 0 renamed; 12 mapped categories are inactive (reader requires `c.active=1`, never selected); S1: 854/885 get a meaningful category, 31 → `null` (offline export: 854/889) | none |
| D1 collation | CONFIRMED | NON_BLOCKING | `ps_product.reference`, `ps_product_lang.name/description_short/description`, `ps_product_attribute.reference` = `utf8mb4_general_ci` (case- and accent-insensitive); `sql_mode = NO_ENGINE_SUBSTITUTION` (zero dates allowed; `ESCAPE '!'` safe) | none |

### Production configuration findings

- **DB/schema:** PrestaShop 1.7.8.3 on MariaDB 10.6.25; every reader column exists; no semantic difference from the local kit found.
- **Tax:** single group, CL 19 %, all sellable products; the flat-rate assumption holds.
- **Specific prices:** today only unbounded-end percentage reductions, tax-included basis, public scope; no ties, no future-starting rows, no bounded window active (so `validUntil` is currently bounded only by the 15 s owner TTL). Engine and PrestaShop agree for all current data. Latent, not present in data: PrestaShop orders `from_quantity` before the scope score and `to DESC` before `from DESC`; Catalog's public context uses country 0 / group 0 while PrestaShop's defaults are country 68 / visitor group 1. Both matter only if scoped or quantity rows appear.
- **Backorder:** globally denied; no per-product allow; Catalog semantics identical.
- **Timezone:** `PRESTASHOP_TIMEZONE = America/Santiago`, confidence HIGH (B7).
- **Category:** the J1D-CAT-02 premise is confirmed in production (default category is the root for every product); the trust map has no drift.
- **Collation:** case/accent-insensitive; J1D-CAT-01 token retrieval behaves as tested (`ñ` also folds to `n`, which only widens recall).
- **Bounds / retrieval:** no contract bound at risk. Candidate retrieval has no row cap and does not filter by `active`; its upper bound is the whole table (1 570 products, 467 combinations, 9 487 specific-price rows) — small; latency to observe in the production smoke.
- **Multi-shop (new):** 3 active shops in one group with `share_stock = 0`: 1 "Pesas Chile" (default, online), 2 "Tienda - Salvador 985" (physical store, own stock), 3 "Eventos". Catalog is pinned to shop 1 (`PRESTASHOP_SHOP_ID` must be 1), so answers reflect **online** price and stock only. Not a contradiction; a scope fact R4 must not present as physical-store stock.

### Snapshot state

| Capability | Status | Evidence |
|---|---|---|
| productSemantics | UNKNOWN | not yet read (requires the Catalog EC2 host; SSH identity located, host/user pending). The local copy has no `catalogPresence` → if production matches, `INCOMPATIBLE_WITH_J1D` |
| trainingSemantics | UNKNOWN | not yet read |
| relationships | UNKNOWN | not yet read |
| catalogPresence | present: unknown; coverage: unknown | |

Catalog `/health/ready` is reachable only on the EC2 host (`127.0.0.1:4010`, PM2); the port is
not exposed externally (timeout on the public IP).

### Deploy impact projection (Catalog `47875d5`)

- commercial truth (`/v2/catalog/*`): **READY**, provided `PRESTASHOP_TIMEZONE=America/Santiago`,
  `TAX_RATE` 0.19 (default) and `PRESTASHOP_SHOP_ID=1` in the deployed environment.
- semantic intelligence (product semantics): UNKNOWN; UNAVAILABLE if the production snapshot
  lacks `catalogPresence` (J1D-CAT-04 rejects it; 503 on its own endpoints only).
- training intelligence: UNKNOWN (READY with a valid snapshot, otherwise UNAVAILABLE).
- relationships: UNKNOWN (UNAVAILABLE without `active.json`).
- global readiness: `/health/ready` 200 `ready`, or 200 `degraded` with any optional capability
  missing; 503 only if the database (or configured Redis) is down (J1D-CAT-05).

### Remaining blockers

- Commercial truth: none. `PRESTASHOP_TIMEZONE=America/Santiago` is a deploy-time
  configuration precondition, not a code change.
- Evidence gap (input to Step 3, not a commercial blocker): production snapshot state and the
  deployed environment values (`TAX_RATE`, `PRESTASHOP_TIMEZONE`, snapshot dirs), readable
  on the EC2 host.

### Step 3 decision required

1. Read the production snapshot state on the EC2 host (read-only) to classify the three
   capabilities.
2. Then decide, for each of product semantics / training semantics / relationships found
   incompatible or missing: rebuild before deploying Catalog `47875d5`, **or** deploy and
   accept that capability as `degraded`/`unavailable` until rebuilt.
3. Approve `PRESTASHOP_TIMEZONE=America/Santiago` as part of the deploy configuration.

Step 2 outcome: **PASS_TO_STEP_3** on commercial truth (no contradiction affecting price,
sellability, identity or freshness); snapshot classification pending the host read.

**R4-J1 — NOT CLOSED.**

---

## Step 3 — EC2 Runtime and Snapshot Inspection

Executed 2026-09-30, 16:31–16:40 UTC, read-only. SSH `ec2-user@98.80.166.131` with the
operator key `crm.pem` used as-is (no permission change); `StrictHostKeyChecking=yes`
against the existing `known_hosts` entry (nothing written locally or remotely).
Source of truth for host/user: CRM `docs/audits/r3-p7-13-continuity-vulnerability-degradation.md`
§7.1 ("Host verificado: `98.80.166.131`, checkout `/home/ec2-user/CRM-Customer-360`, usuario
`ec2-user`", 2026-09-22) and `r3-p7-6-runtime-config-parity-audit.md` §0 (EC2 verified
2026-09-21; `catalog-service` online on port 4010). Commands used: `hostname`, `ps`,
`readlink /proc`, `ss`, `pm2 jlist` filtered on the host, `git --no-optional-locks`
(never writes the index), `stat`, `find`, `du`, `cat` of `active.json`, `jq`/`sha256sum`
on snapshots, allowlist filters on `.env` and `/proc/<pid>/environ`, `curl` GET of
`/health/*`, aggregation of the PM2 log. Secrets reported only as PRESENT/MISSING or a
12-hex sha256 prefix for equality checks. Evidence of the rounding query:
`docs/audits/r4-j1d-step3/`.

### Runtime

| Item | Value |
|---|---|
| Host | `ip-172-31-1-183.ec2.internal`, Amazon Linux 2023 (kernel 6.18), up 13 d |
| Process manager / name | PM2 (user `ec2-user`) / `catalog-service`, fork mode, 0 restarts |
| PID / started | 5476 / 2026-09-16 17:40 UTC |
| cwd (from `/proc/5476/cwd`) | `/home/ec2-user/services/MS-pesaschile-catalog-service` |
| exec | `node dist/src/server.js`, Node 22.23.1 |
| Listener | `127.0.0.1:4010` only (not exposed; explains the external timeout) |
| Deployed revision | **`7a214f4`** (2026-09-10, "derive semantic catalog presence from live truth"), branch `main`, 0 dirty tracked files; `dist/src/server.js` built 2026-09-10 19:42 UTC, before the process start → the process runs this build. No `zonedTime.js`, no `domain/catalog/v2` in `dist` (pre-v2). |
| J1D availability | `47875d5` is `origin/main` on GitHub (`git ls-remote`); the EC2 clone has not fetched it (its `origin/main` = `7a214f4`). `7a214f4` is an ancestor: J1D = 4 commits (`7097db2`, `4fd891f`, `cbe4ac6`, `47875d5`). |
| Co-located | `customer-profile`, `crm-web`, `crm-outbox`, `crm-turn-settle`, `r4-channel-gateway`, `r4-sales-worker` (online); `quote-service`, `crm-followup`, `crm-commercial-work` (stopped) |

### Effective configuration

Process environment overlays `.env` (dotenv does not override); no relevant key is
injected by PM2 — every value below comes from `.env` (last modified 2026-08-21).

| Key | Current | Required by J1D | Action |
|---|---|---|---|
| `PRESTASHOP_SHOP_ID` | 1 | 1 | NONE |
| `TAX_RATE` | 0.19 | 0.19 | NONE |
| `PRESTASHOP_TIMEZONE` | unset (J1D default `UTC`) | `America/Santiago` | **ADD** — REQUIRED_CONFIG_CHANGE_FOR_DEPLOY |
| `PRESTASHOP_LANG_ID` / `CURRENCY_ID` / `CURRENCY_CODE` | 1 / 1 / CLP | same | NONE |
| `PRESTASHOP_COUNTRY_ID` / `CUSTOMER_GROUP_ID` | 0 / 0 | (Step 2: no scoped rows) | NONE |
| `PRESTASHOP_DB_PREFIX` | `ps_` | `ps_` | NONE |
| `DB_HOST` / `DB_NAME` / `DB_USER` | PRESENT (= Step 2 RDS host) / `pesas_productiva` / PRESENT (= the SELECT-only account used in Step 2) | — | NONE |
| `DB_PASSWORD` | PRESENT (REDACTED) | — | NONE |
| `CACHE_DRIVER` / `REDIS_URL` | `memory` / MISSING → Redis not used | — | NONE |
| `API_KEY` / `CATALOG_API_KEYS` | PRESENT / MISSING — one shared key, identical (hash) to the CRM's and Customer Profile's | — | NONE for Step 4 (see Step 6 note) |
| `CATALOG_PUBLIC_BASE_URL` | unset → `https://pesaschile.cl` | same | NONE |
| `RELATIONSHIP_/PRODUCT_SEMANTIC_/TRAINING_SEMANTIC_SNAPSHOT_DIR` | unset → `data/…` relative to cwd | same (keep cwd) | NONE |
| `NODE_ENV` / `HOST` / `PORT` | production / 127.0.0.1 / 4010 | — | NONE |
| DB pool / timeout / caches / rate limit | 5 / 3000 ms / product 900 s, price 60 s, stock 15 s, search 300 s / 120 per 60 s | — | NONE |

### Product semantics snapshot

| Field | Value |
|---|---|
| Pointer | `data/product-semantic-snapshots/active.json` → `sha256:a86a8c6f5208…9d`, schemaVersion `1` |
| File | `snapshots/a86a8c6f…9d.json`, 2 274 120 B, file sha256 `50ab4857…fd4` |
| builtAt | 2026-09-10T19:42:28.157Z (built by the deployed `7a214f4`) |
| Records | 2 011 (`recordCount` = `records.length` = `sourceProductCount` = Σ classificationCounts) |
| Versions | ontology `commercial-product-ontology-v3`, classifier `product-semantic-classifier-v1` |
| catalogPresence | **2 011 / 2 011** — `current_catalog` 1 052, `historical_order_detail_only` 959; 0 invalid |
| Strict shape | one record key set (exactly the 11 J1D fields), valid statuses/hashes, string ids |
| Loaded now | `product_semantic_snapshot_loaded` (2 011) at the 2026-09-16 start |
| **Status** | **READY_COMPATIBLE** — the only schema change in J1D is `catalogPresence` becoming required; every record has a valid value, so the strict parse equals today's parse |

Other files in the directory: `f4c0b837…` (2026-09-10, with presence) and `79cef493…`
(2026-08-31, **no** presence — the build that matches the older local copy; not active).

### Training semantics snapshot

| | v1 (`data/training-semantic-snapshots`) | v2 (`…/v2`) — the one the runtime loads |
|---|---|---|
| Pointer | `sha256:63fd4103…0d`, schema 1, activated 2026-09-10T16:52:32Z | `sha256:045f04fb…c1`, schema 2, activated 2026-09-10T16:52:47Z |
| Versions | registry v1, classifier v1.1 | registry v2, classifier v2.1, source v1 `63fd4103…` |
| generatedAt / records | 2026-09-10T16:52:31Z / 2 011 | 2026-09-10T16:52:47Z / 2 011 |
| Loaded now | — | `training_semantic_snapshot_v2_loaded` (2 011) |
| **Status** | — | **READY_COMPATIBLE** (J1D does not change the training stores/contracts; readiness uses the same v2 reader's metadata) |

### Relationship snapshot

| Field | Value |
|---|---|
| Pointer | `data/relationship-snapshots/active.json` → `sha256:021c4b5e…09` |
| Content | schema 1, model `same-order.real-prestashop.v1`, 6 136 relationships, evidence window 2025-01-01 → 2026-08-21 |
| Loaded now | `relationship_snapshot_loaded` at start; `/health/ready` `relationshipSnapshot: ok` |
| **Status** | **READY_COMPATIBLE** (loader and contract unchanged by J1D). Note: evidence ends 2026-08-21 (≈40 days old) — freshness, not compatibility |

### Current capability state (`7a214f4`)

`GET /health/live` 200 `{"status":"ok"}`; `GET /health/ready` 200
`{"status":"ok","checks":{"database":"ok","redis":"ok","relationshipSnapshot":"ok"}}`
(this build does not report semantics in readiness; the boot log shows both semantic
snapshots loaded). commercialTruth (v1) READY · productSemantics READY ·
trainingSemantics READY · relationships READY · `/v2/catalog/*` does not exist.

### Projected J1D capability state (`47875d5`, not deployed)

- COMMERCIAL TRUTH: **READY** — same DB/account/shop/tax verified in Step 2; `/v2/catalog/*`
  becomes available. Needs `PRESTASHOP_TIMEZONE=America/Santiago`; without it windows are read
  as UTC (no numeric effect today — no bounded window is active — but wrong for the next one).
- PRODUCT SEMANTICS: **READY** (compatible snapshot above).
- TRAINING SEMANTICS: **READY** (v2 snapshot loads; readiness reads its metadata).
- RELATIONSHIPS: **READY**.
- GLOBAL READINESS: HTTP **200**, `status: "ok"`, `checks.capabilities` all `ok`; no degraded
  capability expected. (503 `unavailable` only if the DB fails; 200 `degraded` only if a
  snapshot fails to load.)

### Legacy consumer impact

Evidence: Catalog PM2 log 2026-09-14 → 2026-09-30 (338 lines, routes without query strings,
`reqId` caller tags), CRM code (`lib/catalog/httpCatalogAdapter.ts`,
`lib/catalog/search-products-v2/httpCatalogSearchProductsV2Client.ts`), `.env` key names.

| Consumer | Routes observed | Class | Impact of J1D |
|---|---|---|---|
| CRM R3 WhatsApp agent (`native-whatsapp-turn-settle`) | `GET /v1/products/:id` 80, `GET /v1/products/semantics/registry` 8, `GET /v1/products/training-semantics/registry` 8, `POST /v1/products/batch` 1 | CONFIRMED_ACTIVE (last 2026-09-25) | none on capabilities (all stay READY); `/v1/products/:id` pricing (`priceResolver`) changes only the tie-break direction and the amount-discount `discountValue` — neither occurs in current data (Step 2 B4/B5) |
| CRM, untagged caller (search → `/:id` → `/:id/semantics` → `POST /api/v2/recommendations/search-products`, 7 flows) | as listed | CONFIRMED_ACTIVE (last 2026-09-25); process (web console vs worker) not distinguishable | **price rounding change** in the recommendations commercial-price path (`CommercialPriceCalculator`): S8 — 117 currently discounted units, **20 drop by 1 CLP**, none rise (percentage now applied in net, rounded once). Semantics unaffected |
| CRM semantic discovery (`POST /v1/products/semantic-discovery/query`) | 0 calls | NO_EVIDENCE_OF_USE (code present in the CRM adapter) | none |
| Customer Profile | 0 calls in Catalog log; 0 catalog lines in its own log; `.env` has `CATALOG_SERVICE_*` (same shared key) | NO_EVIDENCE_OF_USE (configured) | none |
| Human console using product semantics | cannot be separated from the untagged CRM caller | UNKNOWN | semantics stay READY → none |
| R4 (`r4-sales-worker`) | 0 calls; no `R4_CATALOG_*` in its run scripts | NO_EVIDENCE_OF_USE | none (profile v1) |
| `/health/ready` consumers | only this inspection | NO_EVIDENCE_OF_USE | response gains `checks.capabilities`; 503 body status becomes `unavailable` |

No capability currently used in production becomes UNAVAILABLE → no
DEPLOYMENT_IMPACT_REQUIRES_DECISION for snapshots. One legacy behaviour change requires
acknowledgement: **LEGACY_PRICE_ROUNDING_CHANGE** (−1 CLP on 20 units, recommendations path).

### Required deployment config delta (Step 4, not applied)

```
PRESTASHOP_TIMEZONE:  current <unset>  required America/Santiago  action ADD
PRESTASHOP_SHOP_ID:   current 1        required 1                 action NONE
TAX_RATE:             current 0.19     required 0.19              action NONE
(all other keys)      unchanged                                   action NONE
```

Code delivery: EC2 `git fetch` + fast-forward `7a214f4 → 47875d5`, `npm ci`, `npm run build`,
PM2 restart with the updated `.env` (`--update-env` or stop/start). `data/` is untracked and
untouched by the deploy. Step 6 note (not Step 4): a dedicated R4 key needs `CATALOG_API_KEYS`
**listing the existing shared key too**, because `CATALOG_API_KEYS` replaces `API_KEY` when set.

### Snapshot decision recommendation

**OPTION A — deploy with current snapshots.** All three are compatible with the J1D loader and
loaded today; no rebuild needed, no capability degrades. (Relationship evidence ending
2026-08-21 is a separate freshness decision, not a J1D prerequisite.)

### Remaining blockers

- None on commercial truth or snapshots.
- Decisions before Step 4: (1) approve `PRESTASHOP_TIMEZONE=America/Santiago`; (2) acknowledge
  LEGACY_PRICE_ROUNDING_CHANGE (−1 CLP, 20 units, CRM recommendations path) or require it be
  checked in the Step 5 parity sample against the storefront; (3) authorize the deploy
  procedure above (includes a restart of `catalog-service`, which the CRM agent uses live).

**R4-J1 — NOT CLOSED.**

---

## Step 5 — first attempt (17:00Z, superseded by the rerun below)

Executed 2026-09-30T17:00Z, read-only (SSH `ec2-user@98.80.166.131`). **Stopped at preflight:
`DEPLOY_CONFIG_INCORRECT`.** Evidence: `docs/audits/r4-j1d-step5/first-attempt/`.

### Deployment identity

`47875d5fe0f98f17c1d96863f02a5ed7e4195694`, 0 dirty tracked files, `dist` built 16:51:40Z;
PM2 `catalog-service` pid 1869519 online since 16:52:33Z (1 restart = the deploy), cwd = service
dir, `127.0.0.1:4010`, Node 22.23.1. Effective config: `PRESTASHOP_SHOP_ID=1` ✅, `TAX_RATE=0.19` ✅,
**`PRESTASHOP_TIMEZONE` unset → code default `UTC`** ❌ (required `America/Santiago`). Absence checked by
key names in `.env` (unchanged since 2026-08-21), `/proc/<pid>/environ`, PM2 stored env; no ecosystem file.

### Runtime health

`/health/live` 200 `ok`; `/health/ready` 200 `ok`, `capabilities` commercialTruth / relationships /
productSemantics / trainingSemantics all `ok`. Boot log: the three snapshots loaded (same ids as Step 3);
no warn/error since 16:50Z (NO_RELEVANT_ERRORS).

### Sections not executed (stop condition)

Legacy sanity, v2 route smoke, Gold v0 live, product context, item context, error semantics, category
validation, pricing parity, legacy −1 CLP delta, OD-1, OD-2, OD-3, sellability/backorder, performance,
post-smoke logs: **NOT RUN**.

### Blocking findings

- `PRESTASHOP_TIMEZONE` missing in production. Effect today: none measurable (Step 2: no active bounded
  promotion window, no future-starting row); the first dated promotion would be windowed ~3 h off.
  v1/CRM paths do not read the setting.

### Nonblocking findings

- Deploy otherwise healthy; the CRM-facing service remains in rotation (no rollback indicated).

### R4 readiness verdict

**NOT_READY_FOR_R4.** Resume: operator adds `PRESTASHOP_TIMEZONE=America/Santiago` to the Catalog `.env`,
restarts with `pm2 restart catalog-service --update-env`, then Step 5 reruns from preflight.

**R4-J1 — NOT CLOSED.**

---

## Step 5 — Production Catalog Smoke & Parity

Rerun 2026-09-30, 17:06–17:25 UTC, read-only. Transport: local SSH port-forward to
`127.0.0.1:4010` (no remote command; closed afterwards), shared service key (value never printed).
Parity authority: the public storefront `https://pesaschile.cl` product pages (`itemprop="price"`),
plus SELECT-only production queries (S9–S13). Evidence: `docs/audits/r4-j1d-step5/`.

### Deployment identity

`47875d5fe0f98f17c1d96863f02a5ed7e4195694`, 0 dirty tracked files, `dist` built 16:51:40Z;
`PRESTASHOP_SHOP_ID=1`, `TAX_RATE=0.19`, **`PRESTASHOP_TIMEZONE=America/Santiago`** (added to `.env`
17:03:57Z by the operator); PM2 `catalog-service` online, `127.0.0.1:4010`, Node 22.23.1.
During the smoke the operator restarted the service twice (17:12:37Z, 17:13:07Z: PM2 `SIGINT`, exit 0,
graceful "Shutting down"; 4 interactive operator ssh sessions; no cron/watch). Not caused by the smoke;
no request failed server-side; the interrupted sections were rerun.

### Runtime health

`/health/live` 200 `ok`; `/health/ready` 200 `ok`, capabilities commercialTruth / relationships /
productSemantics / trainingSemantics all `ok`; snapshots loaded at every start (same ids as Step 3).

### Legacy sanity

All 200, shapes intact, no 5xx: `GET /v1/products/545` (84 990, stock 13, shop 1), `/v1/products/545/semantics`,
semantics and training registries, `POST /v1/products/semantics/batch`, `POST /v1/products/batch`,
`GET /v1/products/search`, `POST /api/v2/recommendations/search-products` (0 recommendations for P545).
**Pre-existing legacy defect found (not a J1D regression):** `/v1/products/:id` and `/v1/products/batch`
apply **no** current promotion (P2340, P382, P2264, P1136, P2338 returned at regular price; storefront shows
15–55 % off). Cause: mysql2 returns `0000-00-00 00:00:00` as `Invalid Date`; `priceResolver`'s
`isValidDateWindow`/`isStillActive` then reject the row. Every current promotion has zero dates. J1D did not
touch those functions, the repository query or the pool. The CRM WhatsApp agent uses this route.

### v2 route smoke

`POST /v2/catalog/search`, `GET /v2/catalog/products/{productKey}/context`,
`GET /v2/catalog/items/{itemKey}/context` all present, authenticated, `schemaVersion: 1`, contract-checked.

| Query | Result |
|---|---|
| `BORE20` | P545 `exact_reference`, total 1 ✅ |
| `barra olimpica 20 kg` | 11, all 20 kg barbells 3/3 tokens ✅ |
| `kettlebell` | 27 ✅ |
| `kettlebell 20 kg` | 3 (P186 first; no 24 kg) ✅ — was false-zero |
| `disco 10 kg` | 7 (P145, P1497 first); description matches carry an exact "10 kg" (S11: 0 with "110 kg") ✅ — was false-zero |
| `banco ajustable` | 21 ✅ — was 0 |
| `pesa rusa` / `banca ajustable` | 22 / 2 via description (measured) |
| `mancuena` / `kettelbell` | 0 / 0 (typo, measured) |

### Gold v0 live

Versioned harness `scripts/catalog-v2/evaluate-search-gold.ts` in HTTP mode against production:
exact_sku 7/7, product_name 4/4, multi_token_nominal 4/4 (recall 100 %), unit_bearing 3/3 (0 exclusion
violations), supported_synonyms 6/6, typo 0/4 (measured); deterministic ordering; **GOLD v0: PASS**.

### Product context

15 keys: simple, variants, variant selection (P2128, P1136 → `sellableItem: null`, `variantOptions` listed,
no invented variant), promotions, zero stock (P2338 `not_sellable/out_of_stock`, basis `not_offerable`),
inactive (P2327 `found`, `status.active=false`, `inactive`), not found (P99999 `not_found`). Facts/derived/
inferred/provenance/freshness present. `inferred.frequentlyBoughtTogether` is always
`unavailable/snapshot_unavailable`: `bootstrap.ts` never wires a provider into `CatalogContractService`
(the relationship snapshot itself is loaded). `provenance.serviceBuildRef = "catalog-service@local"`
(`CATALOG_SERVICE_BUILD_REF` unset). `publicUrl` uses `/categories/…`, which the storefront redirects to
`/categorias/…` (200).

### Item context

Simple (P2248, P545), concrete variants (P2128-V663/V664 by colour, P1136-V229/V230 by size), in stock,
zero stock (P2338), discounted, inactive (P2327), quantity 3: identity, variant, tax (0.19,
`configured_flat_rate`), availability and sellability correct; `P1136` → `variant_required`.
Backorder-allowed item: none exists in production (Step 2 B6).

### Error semantics

`not_found` for unknown product/item/variant (200 + typed status, per the frozen contract);
`variant_required`; 400 `invalid_request` for malformed keys, quantity 0/100, query < 2 chars;
401 `unauthorized` without key; no stack traces, no secrets, no 5xx. Lenient: an unknown extra field
in the search body is stripped (200), not rejected.

### Category validation

92 category samples across search/context: 0 root `CATEGORÍAS`; kettlebells → Kettlebells de Acero/Vinilo,
discs → Discos de Acero / Con Agarre, benches → Bancos Ajustables/Abdominales/Ergo/Olímpicos, barbells →
Barras Hombre 20 kg / Especiales, racks → Half/Power/Squat Racks; `null` only for "2da Selección" outlet
lines (intended).

### Pricing parity

25 units vs storefront: **6 match** (P545, P2248, P2128 from, P1136 from 30 %, P2338 50 %, P2264 35 %),
**19 differ by −1 CLP** — all percentage-discounted units on a rounding boundary.

### Legacy −1 CLP delta

Of the 20 units where J1D and legacy rounding differ, the storefront equals **legacy in 19/20** and J1D in
1/20 (P2264). The J1D change is not a correction: PrestaShop rounds the tax-included price before applying
the percentage. Exact-decimal test over the 20 storefront values: gross rounded to CLP → 19/20; to
6 decimals → 16/20; **to 5 decimals → 20/20**; no intermediate rounding (J1D) → 1/20 (hypothesis for the fix).
Affected surfaces: `/v2/catalog/*` and, since J1D, the CRM recommendations path (`CommercialPriceCalculator`).
Classification: **PRICING_CONTRADICTION — BLOCKING.**

### OD-1 price-from

`basis: offerable` whenever a unit is offerable (P2128, P1136 — 2 of 4 variants sellable); `not_offerable`
fallback on zero-stock products (P2338, P2337). Production has **no** variant product whose cheaper variant is
unorderable while another is orderable (S9c/S10a empty), so the "cheap non-offerable variant never lowers
`from`" rule cannot be exercised live; covered by unit tests. PASS with limited live coverage.

### OD-2 promotion normalization

Shape PASS: `{type: percentage, percentOff, amountOffGross: null, validUntil}` with `regularGross` = storefront
regular price (e.g. P2340 13 990, 55 %); no `reduction_tax` exposed. Final price FAIL on boundary units (above).

### OD-3 freshness

`validUntil = asOf + 15 s`; immediate repeat → `cache.hit: true`, same `asOf`; whitespace/case-normalized query
→ cache hit; request after `validUntil` → new `asOf`/`validUntil`, `hit: false`. No stale answer served. PASS.

### Sellability/backorder

In stock → `sellable/in_stock` (P2248 qty 47 = PS); zero stock + no backorder → `not_sellable/out_of_stock`
(P2338, `out_of_stock=2` → global deny); backorder-allowed: none in production. Availability reflects the
online store `SHOP_ID=1` only. PASS.

### Performance

Via tunnel (≈+150 ms): exact 225–243 ms, multi-token 268–288 ms, product 171–409 ms, item 169–215 ms; broad
`barra` (213 matches) 1.29–1.37 s (server 1.07–1.29 s) on every cache miss. No timeout, no 5xx.

### Post-smoke logs

375 info lines, 0 warn/error, 0 5xx, no contract/SQL/snapshot/timeout events: NO_RELEVANT_ERRORS.

### Nonblocking findings

- Typo tolerance absent (0/4, measured).
- Broad search ≈1.2 s server-side (no row cap).
- `frequentlyBoughtTogether` never wired in v2 (reports `snapshot_unavailable` while the snapshot is loaded).
- `serviceBuildRef` not set to the deployed SHA; `publicUrl` path `/categories/` relies on a redirect.
- Unknown search-body fields are stripped instead of rejected.
- Relationship snapshot evidence ends 2026-08-21; features/product up to 37 of 40.
- Legacy (CRM) `/v1/products/:id` ignores every zero-dated promotion (pre-existing; not a J1D regression, but a
  live commercial-truth defect in the CRM path).

### Blocking findings

- **PRICING_CONTRADICTION:** 19/20 boundary percentage-discount units priced 1 CLP below the storefront by
  `catalog-commercial-v2.1.0` (and by the J1D `CommercialPriceCalculator`).

### R4 readiness verdict

**NOT_READY_FOR_R4 → RETURN_TO_CATALOG_FIX.** Align the rounding of both engines with the storefront
(evidence and the 20 reference values in `pricing-parity.json`), add those units as regression fixtures,
redeploy, rerun Step 5. R4 was not connected; profile v2 not enabled.

**R4-J1 — NOT CLOSED.**

---

## J1D-R1 — PrestaShop pricing parity remediation (Catalog, local, not committed)

- Invariant proven from PrestaShop 1.7.8.3 source + production settings: tax-included price in
  doubles, reduction applied, rounded to 6 decimals (`priceCalculation`, `$decimals = 6`), then to
  the currency precision (`getProductProperties`, CLP 0), PHP 7 `round` half up. Emulation: 21/21
  storefront samples; without the 6-decimal stage 2/21.
- Both Catalog paths (v2 engine, commercial-truth calculator) duplicated the same one-step rounding;
  both now price through one primitive (`src/domain/pricing/prestashopPrice.ts`). Engine
  `catalog-commercial-v2.2.0`; `schemaVersion` 1.
- 20-unit production regression: 19 failing per path before, 20/20 per path after. Catalog suite:
  2 381 passed, 12 failed = the 12 pre-existing snapshot-data tests (§10.1).
- Owner fixtures regenerated: only `engineVersion` in 6 item fixtures + MANIFEST
  (canonical sha256 `5532c7b7…f993`).
- R4 resync after the Catalog commit: fixtures + MANIFEST + `SOURCE.json` (new owner SHA and
  manifest hash), and `tests/unit/catalog-http/adapter.test.ts:76` expectation to v2.2.0. No R4
  commercial logic change.
- Separate: `CAT-HOTFIX-V1-ZERO-DATE-PROMOTIONS` (Catalog `docs/audits/`), open, not fixed.

**R4-J1 — NOT CLOSED.**
