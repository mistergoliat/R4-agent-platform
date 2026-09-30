# R4-J1D — Production Catalog Closure

Status: **IN PROGRESS — offline closure complete; production evidence pending authorization**
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

**Not executed — requires explicit read authorization** (SELECT-only account,
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
  capability temporarily.
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
| Catalog J1D | `47875d5` (committed, not pushed, not deployed; engine `catalog-commercial-v2.1.0`, manifest `223b3550…c72e`) |
| R4 J1C baseline | `c839688` (committed, not pushed) |
| R4 J1D | commit that contains this document (synced to Catalog `47875d5`; not pushed) |
| Deployed Catalog | none |
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
