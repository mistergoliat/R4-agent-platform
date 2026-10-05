# R4-J3A — Existing Quote Service Production Audit

Status: AUDIT ONLY. No code, configuration, database or deployment was changed.
No mutation endpoint was called. Live probing was limited to `pm2 ls`,
`pm2 describe` (filtered: no env), `curl /health*` and filtered log tails on
the production host.

Date: 2026-10-04.

Evidence sources:

| Source | Ref |
|---|---|
| Quote Service repo | `E:\dev\codex\MS\MS-pesaschile-quote-service` @ `fade75d` (main = origin/main). Paths below are relative to that repo unless prefixed `R4:` or `CRM:` |
| Production deployment | EC2 `Master`, `/home/ec2-user/services/MS-pesaschile-quote-service` @ `b504f75` (diff to `fade75d` = branding / PDF layout / smoke script only; no API, domain or schema change) |
| Previous caller (precedent) | `CRM:` = `E:\dev\codex\CRM-Customer-360` |
| R4 | `R4:` = this repository @ `ae76a9e` |

---

## A. Executive diagnosis

1. **Quote Service is MODEL B (document/persistence owner), not a commercial
   calculator.** It receives fully resolved line snapshots (description,
   quantity, unit price, tax flag, tax rate) and only *computes arithmetic*
   (line subtotal/tax/total, quote totals, CLP rounding). It never calls
   Catalog, Shipping or PrestaShop and never validates a price
   (`src/http/routes/quote-route.ts:58-85`, `src/domain/quote-line.ts:280-319`,
   `src/domain/quote-pricing.ts:26-45`). Every R4 fixture/port assumption that
   "the owner prices lines from current catalog data and computes shipping
   itself" (`R4:adapters/domains/src/quote/port.ts:3-8`) is false.
2. **Create, issue and send are three separate owner operations.**
   `POST /v1/quotes` creates a **draft** (number allocated, no PDF);
   `POST /v1/quotes/:id/issue` renders and stores PDF/HTML and moves to
   `issued`; `POST /v1/quotes/:id/send-email` enqueues an email (outbox,
   async Gmail worker). Nothing is sent on create or issue.
3. **Validity is NOT owned by Quote Service.** `validUntil` is a required,
   caller-supplied timestamp (`quote-route.ts:100`); the service only checks
   `validUntil > createdAt` (`src/domain/quote.ts:412`). The "5 days" exists
   only as hard-coded *copy* in the email template
   (`src/infrastructure/branding/pesaschile-brand-v1.ts:6`,
   `src/infrastructure/documents/quote-email-view-model.ts:108`); the CRM
   caller computed `now + 5d` itself (`CRM:lib/brain/commercial/quote-assembly/assembleQuoteInput.ts:26-27,295-296`).
4. **Idempotency is solid for create and usable for R4.** Header
   `Idempotency-Key` (≤200 chars) is required on every mutation; scope is
   `(key, operation_name)`; the claim, the quote insert and the completion are
   one transaction; same key + same canonical payload ⇒ stored response
   replay; same key + different payload ⇒ 409. R4's `executionKey`
   (`r4x_` + 32 hex) fits. **There is no GET-by-idempotency-key**, so UNKNOWN
   is reconciled by *re-sending the byte-identical frozen request*, not by a
   lookup.
5. **The production Quote Service is down and has no database.** pm2
   `quote-service` is `stopped` after 2595 restarts; last attempts
   (2026-09-16 18:15Z) failed with `Database is not reachable during startup
   validation`; nothing listens on 3011 or 5432 on the host and no Quote
   Service Postgres exists there (only `r4-production-postgres`). The service
   served exactly one request in its life (`GET /v1/quotes?limit=1`,
   2026-09-14). **This is the primary J3 blocker and it is owner operations
   work, not R4 work.**
6. Required owner fields with no R4 source today: `opportunityId` (required,
   opaque), `validUntil` (required), customer `name` (required). Shipping
   enters only as a generic line `type: "shipping"`; there are no carrier
   fields.

Answers to the goal questions:

| Q | Answer |
|---|---|
| A. What does Quote Service own? | Quote identity (UUID), quote number (`PC-000001` sequence), the immutable line/price snapshot it is given, arithmetic totals + CLP rounding, lifecycle state machine, issued PDF/HTML artifacts and their integrity hashes, email delivery outbox, its audit trail, idempotency. |
| B. What must R4 provide? | Every commercial value: line description, SKU, external ids, quantity, **unit price**, `taxIncluded`, `taxRate`; shipping as a priced line; customer name (+ optional contact); `opportunityId`; **`validUntil`**; actor/source/correlation; an idempotency key per operation. |
| C. Calculates vs persists | Calculates: `lineSubtotal/lineTax/lineTotal`, `subtotal/taxAmount/total`, CLP half-up rounding, quote number, timestamps, content hash. Persists/renders verbatim: everything else, including prices and validity. |
| D. External side effects | Create: DB only (+ consumes a number). Issue: DB + files on local disk. Send-email: DB outbox → **Gmail API email to a customer** (async, retried). Expiry job: DB. No calls to Catalog/Shipping. |
| E. What should `quote.create` mean? | "Create **and issue** a formal quote from an R4-resolved snapshot" (owner create-draft + issue, one governed action, two idempotent owner calls). Email sending is a separate, later action. See X. |
| F. What must Governance authorize? | The frozen owner request: lines with prices, shipping line, customer snapshot, validity, total. Not the email. |
| G. Idempotency/retry/reconciliation | Create: replay-by-resend with the frozen body. Issue: replay-by-resend, or read quote state (optimistic version guard prevents double issue). Details in O/P. |
| H. What blocks J3? | Z1 (no running owner/DB in production), Z2 (validity ownership decision), Z3 (opportunityId/customer-name sourcing decision). Everything else is R4 adapter work. |

---

## B. Existing Quote Service architecture

| Item | Finding | Evidence |
|---|---|---|
| Repo / service | `MS-pesaschile-quote-service`, `SERVICE_NAME=pesaschile-quote-service` | `package.json`, `src/infrastructure/config/env.ts:49` |
| Runtime | Node ≥20 (prod runs Node 22.23.1), TypeScript, Fastify 5, zod 4, `pg`, `decimal.js`, `pdfmake` | `package.json:52-58`; prod error log |
| Entrypoint | `node dist/server.js` (`npm start`) | `src/server.ts`, `package.json:13` |
| Host/port | env `HOST` (default `0.0.0.0`) / `PORT` (default 3000). Prod: port **3011**, bound on all interfaces (127.0.0.1, 172.31.1.183, docker bridges) | `env.ts:33-34`; prod out log "Server listening at http://172.31.1.183:3011" |
| Process manager | pm2 `quote-service` (fork, `npm start`, cwd `/home/ec2-user/services/MS-pesaschile-quote-service`). A Dockerfile exists but prod does not use it | prod `pm2 describe`; `Dockerfile` |
| Database | PostgreSQL, schema `quote_service`, `DATABASE_URL`, pool 10, query timeout 15 s; migrations run explicitly (no auto-migrate) | `env.ts:43-48`; `migrations/000001_baseline.cjs:2`; README "Production Notes" |
| Auth | Single static Bearer token `SERVICE_AUTH_TOKEN`, constant-time compare, on `/v1/quotes*` and `/v1/documents*`; `/health*` open | `src/http/service-auth.ts`; `quote-route.ts:248-255`; `document-route.ts` preHandler |
| Network boundary | Internal only by intent (no TLS in-process, plain HTTP). Exposure beyond the host depends on the EC2 security group (not audited) | `server.ts` `app.listen`; prod listen addresses |
| Upstream callers | CRM (`QUOTE_SERVICE_BASE_URL=localhost:3011`); R4 none | `CRM:lib/integrations/quote-service/config.ts`; `CRM:docs/audits/r3-p7-6-runtime-config-parity-audit.md:91` |
| Downstream | Postgres; local filesystem `QUOTE_DOCUMENT_STORAGE_ROOT`; Gmail API (`oauth2.googleapis.com/token`, `gmail.googleapis.com/.../messages/send`) | `env.ts:54`; `src/infrastructure/email/gmail-email-sender.ts:12-13` |
| Scheduled jobs (in-process) | quote expiration (default **disabled**), email delivery worker (on when provider=gmail), orphan document cleanup (default disabled) | `src/infrastructure/runtime/background-job-manager.ts:31-126`; `env.ts:57-67` |
| PDF | In-process `pdfmake` (Puppeteer removed in `f7e4bde`) | `src/infrastructure/documents/native-pdf-renderer.ts`; git log |
| Email | Gmail API with OAuth refresh token; `QUOTE_EMAIL_PROVIDER=disabled|gmail` (default disabled) | `env.ts:63-74`; `app.ts:102-125` |
| Storage | Local filesystem (`quotes/<quoteId>/<contentHash>/…`) — single-host, needs persistent volume | `src/infrastructure/documents/document-paths.ts:16-22`; README "Production Notes" |

Dependency graph (derived from `src/app.ts:51-170`):

```
R4 (future) / CRM
  │  HTTP + Bearer + Idempotency-Key
  ▼
Quote Service API (Fastify, :3011)
  ├─ PostgreSQL  schema quote_service
  │     quotes · quote_lines · idempotency_keys · quote_audit_events
  │     quote_number_seq · quote_deliveries · quote_email_outbox
  ├─ DocumentIssuance (issue only): pdfmake renderer + HTML templates
  │     └─ Filesystem storage (QUOTE_DOCUMENT_STORAGE_ROOT)
  ├─ Email worker (periodic, provider=gmail) ──► Gmail API ──► customer inbox
  ├─ Expiration scheduler (periodic, default OFF)
  └─ Orphan document cleanup (periodic, default OFF)
(no Catalog / Shipping / PrestaShop / Customer calls)
```

---

## C. Exact API surface

All under Bearer auth except `/health*`. Mutations require `Idempotency-Key`
(trimmed, 1–200 chars; `quote-route.ts:171-185`) → 400 `validation_error`
otherwise. Error envelope `{error:{code,message,details?}}`
(`src/http/errors.ts:212-218`). Common errors: 401
`missing_authentication|invalid_authentication`; 400 validation codes
(`errors.ts:44-94`); 404 `quote_not_found`; 409
`invalid_quote_status_transition|draft_only_operation|quote_already_terminal|quote_already_superseded|optimistic_concurrency_conflict|idempotency_key_reused_with_different_payload|idempotency_request_in_progress`;
503 `document_generation_failed|document_storage_failed|email_delivery_unavailable`;
500 `internal_server_error` (`errors.ts:140-182`).

| # | Method + route | Class | Body / query | Success | Side effects | Evidence |
|---|---|---|---|---|---|---|
| 1 | `GET /health` | READ | — | 200 / 503 | DB ping | `health-route.ts` |
| 2 | `GET /health/ready` | READ | — | 200 / 503 | DB, storage, renderer checks | `health-route.ts` |
| 3 | `POST /v1/quotes` | **MUTATION (create draft)** | `opportunityId` (req), `customerId?`, `conversationId?`, `actor{type,id}`, `source{system,correlationId?}`, `currency:"CLP"`, `customerSnapshot`, `items[1..100]`, `validUntil` (req, ISO with offset) | **201** quote DTO | allocates quote number; inserts quote, lines, audit `draft_created`, idempotency | `quote-route.ts:87-101,257-298`; `quote-service.ts:226-295` |
| 4 | `GET /v1/quotes/by-number/:quoteNumber` | READ | — | 200 | — | `quote-route.ts:300-322` |
| 5 | `GET /v1/quotes` | READ | `opportunityId?`, `status?`, `revisionRootId?`, `limit≤100`, `offset` | 200 list, `created_at desc` | — | `quote-route.ts:152-158,324-339`; `quote-repository.ts:274-403` |
| 6 | `PUT /v1/quotes/:id/draft` | MUTATION | `expectedVersion`, actor, source, `customerSnapshot`, `items`, `validUntil` | 200 | replaces lines (draft only), version+1, audit `draft_updated` | `quote-route.ts:103-110,341-375` |
| 7 | `POST /v1/quotes/:id/issue` | **MUTATION (issue)** | `expectedVersion`, actor, source | 200 | renders PDF+HTML+email HTML, writes files, status `issued`, audit `issued` | `quote-route.ts:377-408`; `quote-service.ts:608-730` |
| 8 | `POST /v1/quotes/:id/accept` | MUTATION | `expectedVersion`, actor, source | 200 | status `accepted` | `quote-route.ts:410-438` |
| 9 | `POST /v1/quotes/:id/mark-paid` | MUTATION | same | 200 | status `paid` | `quote-route.ts:440-468` |
| 10 | `POST /v1/quotes/:id/cancel` | MUTATION | same | 200 | status `cancelled` | `quote-route.ts:470-498` |
| 11 | `POST /v1/quotes/:id/expire` | ADMIN/INTERNAL | same, `actor.type ∈ {system,service}` | 200 | status `expired` (only after `validUntil`) | `quote-route.ts:38-41,500-528` |
| 12 | `POST /v1/quotes/:id/revisions` | MUTATION | `expectedVersion`, actor, source, `newValidUntil?` | **201** new draft | new quote + new number, links supersession | `quote-route.ts:124-129,530-562`; `quote-service.ts:444-539` |
| 13 | `GET /v1/quotes/:id/documents` | READ | — | 200 `{available, contentHash, pdf{documentRef,sha256}, html{…}}` | — | `quote-route.ts:564-579` |
| 14 | `GET /v1/quotes/:id/audit` | READ | `limit`, `offset` | 200 | — | `quote-route.ts:581-605` |
| 15 | `POST /v1/quotes/:id/send-email` | **MUTATION (outbound)** | `recipient?`, actor, source | **202** delivery `pending` | delivery + outbox row, audit `email_delivery_requested`; worker later sends via Gmail | `quote-route.ts:131-135,607-626`; `quote-delivery-service.ts:131-235` |
| 16 | `GET /v1/quotes/:id/deliveries` | READ | `channel?`, `limit`, `offset` | 200 | — | `quote-route.ts:628-653` |
| 17 | `GET /v1/quotes/:id/deliveries/:deliveryId` | READ | — | 200 | — | `quote-route.ts:655-682` |
| 18 | `GET /v1/quotes/:id` | READ | — | 200 | — | `quote-route.ts:684-702` |
| 19 | `GET /v1/documents/:documentRef` | READ | — | 200 stream (`application/pdf` attachment / html inline), `X-Document-Sha256` | — | `document-route.ts` |

Timeouts: server `requestTimeout` 15 s, `connectionTimeout` 5 s, DB query
15 s (`env.ts:39-48`, `app.ts:55-59`). No server-side per-operation deadline;
the PDF render runs outside any DB transaction (README "T05").

Quote DTO (all mutations and reads): `quoteId, quoteNumber, opportunityId,
customerId, conversationId, actor, source, status, currency, customerSnapshot,
items[] (incl. lineSubtotal/lineTax/lineTotal), pricing{subtotal,taxAmount,total},
validUntil, version, revision{…}, issuedDocument{available, contentHash,
renderVersion, generatedAt, pdf{documentRef,sha256}, html{…}}, timestamps{createdAt,
updatedAt, issuedAt, acceptedAt, paidAt, cancelledAt, expiredAt}`
(`src/http/quote-presenter.ts:23-46`). Money fields are decimal strings.

---

## D. State machine

States (`src/domain/constants.ts:44-53`, DB check `000002_quote_persistence.cjs:1-3`):
`draft, issued, accepted, paid, cancelled, expired`; terminal = `paid,
cancelled, expired`. There is **no** `sent`, `rejected`, `void`, `failed`,
`pending` quote state (`pending/processing/sent/failed` belong to email
*deliveries*, `constants.ts:64`).

```
           create (POST /v1/quotes)                 revisions (issued → new draft, predecessor stays issued, superseded link)
               │                                                 ▲
               ▼                                                 │
            draft ── PUT /draft (draft only, version+1) ──┐      │
               │ issue (PDF+HTML)                          │      │
               ▼                                           │      │
            issued ────────────────────────────────────────┴──────┘
             │   │  │
     accept  │   │  └─ expire (validUntil < now; scheduler or POST /expire)
             ▼   │                 ▼
        accepted │              expired (terminal)
         │    │  └─ cancel
mark-paid│    └─ cancel ──────► cancelled (terminal)
         ▼
       paid (terminal)
```

| Transition | Actor | Endpoint / job | From | To | Reversible | Timestamp | Audit | External effect | Evidence |
|---|---|---|---|---|---|---|---|---|---|
| create | any actor type | `POST /v1/quotes` | — | draft | via cancel? **no** (cancel requires issued/accepted); drafts are simply left | createdAt | `draft_created` | none | `quote.ts:396-447`; `quote-service.ts:240-291` |
| update draft | any | `PUT …/draft` | draft | draft | yes (edit again) | updatedAt | `draft_updated` | none | `quote.ts:635-664` |
| issue | any | `POST …/issue` | draft | issued | no | issuedAt, issuedDocument.generatedAt | `issued` (+hashes) | files on disk | `quote.ts:666-695` |
| accept | any | `POST …/accept` | issued | accepted | no | acceptedAt | `accepted` | none | `quote.ts:697-716` |
| mark paid | any | `POST …/mark-paid` | accepted | paid | no | paidAt | `paid` | none | `quote.ts:718-737` |
| cancel | any | `POST …/cancel` | issued, accepted | cancelled | no | cancelledAt | `cancelled` | none | `quote.ts:739-758` |
| expire | system/service | scheduler or `POST …/expire` | issued | expired | no | expiredAt | `expired` | none | `quote.ts:760-790`; `quote-service.ts:561-606` |
| revision | any | `POST …/revisions` | issued (not yet superseded) | new draft (predecessor unchanged status) | n/a | new createdAt | `revision_created` ×2 | none | `quote.ts:792-861` |

Notes: a `draft` can never be cancelled or expired — an abandoned draft stays
`draft` forever. `expired` cannot be revived; a revision can only be taken
from `issued` (`quote.ts:793`), so an expired quote needs a brand-new quote.

---

## E. Create / issue / send semantics

**CREATE (`POST /v1/quotes`)** — one DB transaction (`quote-service.ts:226-295`):

| Question | Answer | Evidence |
|---|---|---|
| allocate quote number? | **Yes**, at draft time (`PC-` + 6-digit `nextval`) | `quote-service.ts:242`; `quote-repository.ts:715-723` |
| create draft? | Yes, status `draft`, version 1 | `quote.ts:425,431` |
| immediately issue? | **No** | — |
| create PDF? | **No**; `issuedDocument.available=false` | `quote.ts:436`; `quote-presenter.ts:78-93` |
| persist customer info? | Yes, `customer_snapshot` jsonb | `quote-repository.ts:684` |
| immutable line snapshot? | Snapshot yes; mutable while draft (`PUT /draft`), frozen at issue | `quote.ts:635-664`; README "Historical artifacts are immutable once a quote is issued" |
| calculate totals / VAT? | Yes, arithmetic from caller's unit price/tax flag/rate | `quote-line.ts:280-319`; `quote-pricing.ts:26-45` |
| create expiry? | Stores caller `validUntil`; no expiry scheduling at create | `quote.ts:407-412` |
| send email? | **No** | — |
| return PDF URL? | No | — |
| audit events? | `draft_created` with lineCount/currency/total/validUntil | `quote-service.ts:262-283` |
| invoke another service? | **No** | `app.ts` wiring |

**ISSUE (`POST /:id/issue`)** (`quote-service.ts:608-730`): (1) claim
idempotency in its own committed transaction; (2) read quote; (3) render
email HTML + printable HTML + PDF and write them to disk **outside** any
transaction; (4) new transaction: re-read, `quote.issue()` with
`expectedVersion`, persist, audit `issued`, complete idempotency. On any
error: delete written artifacts (unless already referenced by a committed
issue), mark idempotency `failed`, rethrow (quote stays `draft`).

**SEND (`POST /:id/send-email`)** (`quote-delivery-service.ts:131-235`):
only `issued`/`accepted` quotes with an issued document; recipient =
explicit `recipient` or `customerSnapshot.email` (else 400
`quote_email_recipient_missing`); one transaction writes delivery (`pending`)
+ outbox + audit + idempotency; returns **202**. Actual sending is the
periodic worker (`quote-email-worker.ts:43-191`).

Conclusion: the owner **separates** CREATE, ISSUE and SEND.

---

## F. Commercial ownership matrix

Line fields (`quote-route.ts:58-85`, `quote-line.ts:20-57`):

| Field | Req | Type | Ownership | Evidence |
|---|---|---|---|---|
| `type` | yes | `product|service|shipping` | A supplied | `constants.ts:55` |
| `externalSource`, `externalItemId`, `externalVariantId` | no | opaque strings | A supplied, D persisted (never parsed, never rendered) | `quote-route.ts:60-78`; `issued-quote-document.ts:13-21` |
| `sku` | no | string ≤100 | A supplied, D persisted, rendered | `quote-route.ts:79` |
| `description` (product name/variant) | yes | 1..500 | A supplied, D persisted, rendered | `quote-route.ts:80` |
| `quantity` | yes | decimal string > 0 (fractional allowed) | A supplied | `quote-route.ts:81`; `quote-line.ts:124-137` |
| `unitPrice` | yes | decimal string ≥ 0, **rounded half-up to whole CLP on input** | **A supplied** | `quote-line.ts:139-152`; `money.ts:17-23,73-75` |
| `taxIncluded` | yes | boolean | **A supplied** | `quote-route.ts:83` |
| `taxRate` | yes | decimal ≥ 0 (e.g. `0.19`) | **A supplied** | `quote-route.ts:84` |
| `lineSubtotal` (net) | — | CLP | **B calculated** | `quote-line.ts:291-318` |
| `lineTax` | — | CLP | **B calculated** | idem |
| `lineTotal` (gross) | — | CLP | **B calculated** | idem |
| discount | — | **does not exist** | — | no field anywhere in schema |
| `currency` | yes | literal `CLP` | A supplied, B validated | `quote-route.ts:97`; `000002…:165` |
| shipping | — | only as a line `type:"shipping"` | A supplied | `000005_quote_line_shipping.cjs` |
| `subtotal`, `taxAmount`, `total` | — | CLP | **B calculated** (sums of rounded line values) | `quote-pricing.ts:26-45` |
| quote number, quoteId, timestamps, version | — | — | B generated | `quote-service.ts:241-242` |
| `validUntil` | yes | timestamp | **A supplied** (only `> createdAt` checked) | `quote.ts:407-412` |

Nothing is "C. retrieved from another owner". Persisted values are
re-verified on every read (`QuoteLine.rehydrate`/`QuotePricing.rehydrate`
recompute and reject drift, `quote-line.ts:215-260`, `quote-pricing.ts:47-63`).

**Verdict: MODEL B — document/persistence owner with a deterministic
arithmetic layer.** It is not a pricing engine: it has no catalog access,
no price lists, no discounts, no promotions, no stock, no shipping rating.

---

## G. Catalog relationship

- Quote Service does **not** call Catalog, PrestaShop or read product tables;
  it trusts caller-provided name/SKU/price (`app.ts:51-170` has no such
  dependency; README T07D: "does not … rehydrate Catalog data, or recalculate
  pricing").
- It stores product snapshots (description, SKU, external ids, unit price,
  tax) per line (`000002…:229-289`, `000004…`).
- Duplicated pricing logic inside Quote Service: **none** beyond
  multiplication/tax split/rounding. The divergence risk is therefore entirely
  on the *caller's* choice of unit price.
- R4 Catalog source for each line (`R4:adapters/domains/src/catalog/port.ts:238-278`):
  `getItemContext({itemKey, quantity})` →
  `pricing.finalGross` (UNIT, tax included, *for that quantity tier*),
  `pricing.tax.rate`, `parentProduct.name`, `variant.attributes`,
  `variant.sku ?? parentProduct.sku`, `ref.productId`, `ref.variantId`.
  Mapping: `unitPrice = finalGross.amount`, `taxIncluded = true`,
  `taxRate = tax.rate`, `externalSource = "catalog_service"` (CRM precedent,
  `CRM:assembleQuoteInput.ts:29,112-115`) or an R4-specific value,
  `externalItemId = ref.productId`, `externalVariantId = ref.variantId`.
  The price must come from `getItemContext` with the workspace quantity, not
  from the product-level `priceSummary` (which may be a `from` price).

---

## H. Shipping relationship

- Representation: a generic line with `type: "shipping"` (rendered with label
  "Despacho", `issued-quote-document.ts:149`). No carrier, service type,
  commune, address or ETA fields; commune/region exist only in the customer
  snapshot (`customer-snapshot.ts:5-13`). Carrier name can only travel in
  `description` (and optionally `externalSource/externalItemId`).
- Quote Service does not recalculate shipping; it accepts whatever line it is
  given.
- Mapping of one chosen J2 offer (`R4:agents/sales/src/capabilities/shipping.ts:36-44`):
  `type:"shipping"`, `description:"Despacho <carrierName> – <commune>"`,
  `quantity:"1"`, `unitPrice = price.ownerNet.amount`, `taxIncluded:false`,
  `taxRate:"0.19"`. Quote Service then computes `lineTax = round½↑(net×0.19)`,
  `lineTotal = net + lineTax`, which equals R4's `customerGross =
  floor(net×119/100 + 0.5)` (`R4:adapters/domains/src/shipping/vat.ts:36-40`)
  for every integer net (e.g. DD $1 → tax 0 → total 1). Sending the net with
  `taxIncluded:false` preserves the owner's net exactly; sending
  `customerGross` with `taxIncluded:true` would make the quote re-derive a net
  that can differ by 1 CLP. The CRM "shipping tax metadata missing" blocker
  (`CRM:assembleQuoteInput.ts:179-214`) is resolved by the 2026-10-02 user
  decision that `total_cost` is NET plus ADR-032's VAT policy.
- **R4 gap (not owner):** the Sales workspace has no "selected shipping offer"
  (`R4:agents/sales/src/workspace/model.ts:36-51` — only
  `set_delivery_destination`). Carrier choice by the customer has no durable
  home today.

---

## I. Customer-data requirements

`customerSnapshot` (`quote-route.ts:48-56`, `customer-snapshot.ts:34-73`):

| Field | Class | Notes |
|---|---|---|
| `name` | **REQUIRED** (1..200) | rendered on PDF/email |
| `businessName` | OPTIONAL / DISPLAY | rendered |
| `email` | OPTIONAL at create; **REQUIRED for send-email** unless `recipient` given | validated pattern; `quote-delivery-service.ts:89-108` |
| `phone` | OPTIONAL / DISPLAY | free text ≤100 |
| `address`, `district`, `region` | OPTIONAL / DISPLAY (delivery-relevant only as text) | `native-pdf-renderer.ts:309-315` |
| `customerId` (top level) | OPTIONAL opaque ref | `quote-route.ts:89` |
| RUT / legal name / billing address | **do not exist** | — |
| `opportunityId` (top level) | **REQUIRED** opaque ref ≤200 | `quote-route.ts:88`; `000002…:31-33` NOT NULL |
| `conversationId` | OPTIONAL | `quote-route.ts:90-94` |

Guest quotes: supported as long as a non-empty `name` is given; no customer
identity is needed. **J3 does not depend on J4.** R4's current input schema
requires email-or-phone (`R4:agents/sales/src/capabilities/quote.ts:15-24`),
which is stricter than the owner; the owner needs neither.

---

## J. Totals / VAT / rounding ownership

| Item | Who | Rule | Evidence |
|---|---|---|---|
| unit price | caller | rounded half-up to 0 decimals on input | `money.ts:39-42,73-75` |
| line total (taxIncluded) | Quote | `round(unit × qty)` | `quote-line.ts:291-292` |
| line net (taxIncluded) | Quote | `round(lineTotal / (1+rate))` | `quote-line.ts:293-297` |
| line tax (taxIncluded) | Quote | `lineTotal − lineNet` | `quote-line.ts:298` |
| line net/tax/total (not included) | Quote | `net=round(unit×qty)`, `tax=round(net×rate)`, `total=net+tax` | `quote-line.ts:307-312` |
| discounts | — | not supported | — |
| shipping tax | Quote | as any line, from caller's flag/rate | — |
| subtotal / tax / total | Quote | sums of rounded line values | `quote-pricing.ts:26-45` |
| rounding | Quote | CLP, 0 minor units, ROUND_HALF_UP, at every MoneyAmount op | `money.ts:17-23` |

Quote Service does not validate prices against anything. Divergence risk:

- Catalog price vs quote line: only if R4 forwards a different number than the
  Catalog `finalGross` for that quantity tier, or if the price moves between
  approval and execution (see W). The line *gross* equals Catalog gross ×
  qty exactly for integer CLP prices.
- Shipping `customerGross` vs quote shipping line: zero with the net mapping
  in H.
- Quote `subtotal` (net) is per-line-rounded, so it can differ by a few CLP
  from `round(total/1.19)`. That is the owner's rule; R4 must display the
  owner's numbers, never recompute.
- The PDF always prints "Precios incluyen IVA" regardless of line flags
  (`issued-quote-document.ts:162`) — cosmetic, owner-side.

R4 does not become a second pricing engine: it forwards owner values
(Catalog gross, Shipping net) and reads totals back from Quote.

---

## K. PDF behavior

| Aspect | Finding | Evidence |
|---|---|---|
| When | only on `issue` | `quote-service.ts:637-641` |
| Sync/async | synchronous inside the issue request (outside DB tx) | README T05 steps 3–6 |
| Renderer | pdfmake in-process, Helvetica, render version `quote-pdf-v3` | `native-pdf-renderer.ts`; `env.ts:56` |
| Inputs | immutable canonical snapshot: number, issuedAt, validUntil, customer, lines (incl. shipping), totals | `issued-quote-document.ts:83-115,124-168` |
| Storage | local FS `quotes/<quoteId>/<contentHash>/quote-<sha>.pdf` (+ printable HTML + email HTML) | `document-paths.ts:10-24` |
| URL | none public. `documentRef` = HMAC-signed opaque token; download `GET /v1/documents/:ref` **requires the service Bearer token** | `document-reference.ts:23-36`; `document-route.ts` |
| Regeneration | never; historical artifacts immutable; renderer changes do not re-render | README T07D |
| Dates | rendered as **UTC calendar date** (`dd/mm/yyyy`) | `document-formatting.ts` `formatUtcDateDisplay` |
| Failure | 503 `document_generation_failed`/`document_storage_failed`; quote **stays draft**, idempotency marked `failed` (retryable with same key); crash between file write and commit leaves orphan files for the cleanup job | `quote-service.ts:709-729`; README T05 "Failure behavior" |
| Performance | 10 lines ≈ 83 ms, 30 lines ≈ 54 ms; 10 concurrent ≈ 380 ms | `docs/quote-r1-t07d-lightweight-pdf-renderer.md:184-204` |

Customer PDF access requires either the email attachment or a caller that
downloads with the service token and forwards the bytes (e.g. WhatsApp
document) — not available in R4 today.

---

## L. Email / outbound effects

| Operation | External side effect |
|---|---|
| create | none |
| issue | none outside the host (files on local disk) |
| send-email | **email to a customer via Gmail API**, asynchronously |
| accept / paid / cancel / expire / revision | none |

Email details: provider Gmail API (OAuth refresh token)
(`gmail-email-sender.ts:12-13`, `app.ts:102-111`); enabled only when
`QUOTE_EMAIL_PROVIDER=gmail` (`app.ts:112-125`); recipient = explicit or
`customerSnapshot.email` (`quote-delivery-service.ts:89-108`); attachment
`Cotizacion-<number>.pdf` + stored email HTML (`quote-email-worker.ts:80-97`);
retries: delays 1 m, 5 m, 15 m, 1 h, 4 h, max attempts 5, only for errors
classified retryable (`retry-policy.ts:8-14,49-67`); lease-based claim
(`QUOTE_EMAIL_DELIVERY_LEASE_MS`=120 s, `quote-delivery-repository.ts:636-642`)
⇒ **at-least-once**: a crash after Gmail accepted but before `markDeliverySent`
re-sends after the lease. Dedup: request idempotency only (same key+recipient
⇒ same delivery); a new key creates another delivery/email. Audit:
`email_delivery_requested|sent|failed|retry_scheduled`, recipient masked
(`quote-email-worker.ts:19-28,99-188`).

`quote.create` and `quote.send` are separable in the owner and must stay
separate in R4.

---

## M. Validity / expiration ownership

| Question | Finding | Evidence |
|---|---|---|
| Duration | **not owned**: caller sends `validUntil` | `quote-route.ts:100` |
| 5 days still correct? | Only as email copy constant `QUOTE_EMAIL_VALIDITY_POLICY_DAYS=5` and policy text "válidos por 5 días desde su emisión"; README explicitly: "does not enforce the 5-day policy" | `pesaschile-brand-v1.ts:6`; `quote-email-view-model.ts:108`; README "Validity note" |
| Configured where? | nowhere server-side | — |
| issuedAt | server clock at issue | `quote-route.ts:381` |
| expiresAt | = `validUntil` (caller); checked `> createdAt` and `> issuedAt` | `quote.ts:412,682` |
| Timezone | ISO with offset accepted, stored timestamptz, rendered as UTC date | `quote-route.ts:100`; `document-formatting.ts` |
| Scheduler | in-process, **default OFF** (`QUOTE_EXPIRATION_SCHEDULER_ENABLED=false`), 30 s interval, batch 25, `FOR UPDATE SKIP LOCKED` | `env.ts:57-59`; `quote-repository.ts:733-759` |
| Deterministic? | yes: `issued ∧ validUntil < now` | `quote.ts:769-778` |
| Revive/reissue? | no revival; revision only from `issued` | `quote.ts:793` |

Consequences: (1) if R4 does not supply `validUntil`, nothing does;
(2) the text "5 días desde su emisión" can contradict `validUntil` when
issue happens later than create, or when the caller picks another duration;
(3) with the scheduler off, `status` stays `issued` past `validUntil` — R4
must treat `validUntil` as the validity truth and `status` as possibly lagging.

---

## N. Quote number ownership

`'PC-' || lpad(nextval('quote_service.quote_number_seq')::text, 6, '0')`
(`quote-repository.ts:715-723`) inside the create transaction
(`quote-service.ts:242`); unique constraint `quotes_quote_number_unique`
(`000002…:188-192`). Concurrency-safe (Postgres sequence); **gaps** occur on
rolled-back creates and abandoned drafts (sequences are not transactional);
no reset rule; beyond 999 999 `lpad` truncates to 6 chars — collision with
the unique constraint ⇒ create fails (far-future limit, OPTIONAL OWNER
IMPROVEMENT). `quote_number_seq` is authoritative. Revisions get a new
number (`quote-service.ts:471`). R4 never builds numbers.

---

## O. Idempotency semantics

| Aspect | Finding | Evidence |
|---|---|---|
| Where | header `Idempotency-Key`, required on all 9 mutations, 1–200 chars | `quote-route.ts:171-185` |
| Table | `quote_service.idempotency_keys`, PK `(idempotency_key, operation_name)`, status `in_progress|completed|failed` | `000002…:332-386` |
| Scope | per key **and operation** — the same key may be reused for `create_draft_quote` and `issue_quote` independently | idem |
| Fingerprint | SHA-256 of canonical JSON (sorted keys, `undefined` dropped) of an explicit payload: create = `opportunityId, customerId, conversationId, actor, source, currency, customerSnapshot, items, validUntil` (server timestamps excluded) | `quote-route.ts:276-287`; `canonical-json.ts` |
| Replay | `completed` + same hash ⇒ returns the stored response snapshot (the quote **as it was at completion**, e.g. still `draft`), HTTP 201 again for create | `quote-repository.ts:818-824`; `quote-service.ts:236-238` |
| Conflict | same key, different hash ⇒ 409 `idempotency_key_reused_with_different_payload` | `quote-repository.ts:807-816` |
| In flight | concurrent same key: the second insert waits on the uncommitted unique row, then sees `completed` (create) | `quote-repository.ts:762-799` |
| Failed | `failed` + same hash ⇒ re-claimed (retry allowed) | `quote-repository.ts:826-851` |
| Stuck | `in_progress` committed with no completion ⇒ 409 `idempotency_request_in_progress` **forever** (no lease/timeout). Impossible for create (claim+insert are one tx); **possible for issue** (claim committed separately, `quote-service.ts:613-620`) if the process dies mid-render | `quote-repository.ts:853-860` |
| Retention | `expires_at = now+30d` written but never read or purged ⇒ effectively permanent | `quote-service.ts:233`; grep: no reader |
| "Per cart" | **inaccurate** for the owner: the key is whatever the caller sends. The CRM derived it from `opportunityId + selectionFactId` (`CRM:createQuoteCapability.ts:32-34`) | — |

Mapping `ActionExecution.executionKey → Idempotency-Key`: **safe**, with two
conditions:

1. The **entire** owner request body must be frozen durably before the first
   call and re-sent byte-for-byte on every retry/reconciliation — including
   `validUntil`, prices and `source.correlationId`. Recomputing anything
   (e.g. `validUntil = now+5d`, a fresh Catalog price) on retry changes the
   hash ⇒ 409, never a duplicate. (The CRM had exactly this latent defect:
   `validUntil` recomputed per attempt under a selection-derived key,
   `CRM:assembleQuoteInput.ts:295-296` + `createQuoteCapability.ts:135`.)
2. Use the execution key for create and the same key (different operation
   scope) or a derived key for issue.

Result: same R4 execution key → same quote, never a duplicate commercial
artifact (for create). Issue cannot double-issue regardless of keys because
it requires `draft` + `expectedVersion` (`quote.ts:667-668`).

---

## P. Unknown-outcome / reconciliation analysis

| Case | Create | Issue |
|---|---|---|
| SUCCEEDED | 201 + quote (status `draft`) | 200 + quote (status `issued`, `issuedDocument.available=true`) |
| FAILED_BEFORE_COMMIT | 4xx (validation/auth/conflict) or 5xx; tx rolled back ⇒ no quote, no key | 409/400/503; quote still `draft`; key `failed` (503) or never claimed (4xx before claim) |
| UNKNOWN_AFTER_REQUEST | timeout / connection lost after sending | same |

Reconciliation with existing owner functionality (no owner change):

- **Create UNKNOWN** → re-send the frozen request with the same key.
  Committed ⇒ replay returns the quote; not committed ⇒ creates it now. Both
  converge on exactly one quote. This is `idempotent_replay` recovery, not a
  lookup. Secondary evidence (optional): `GET /v1/quotes?opportunityId=<R4
  ref>` and match `source.correlationId == executionKey`. There is no
  GET-by-idempotency-key; R4's port method `findByIdempotencyKey`
  (`R4:adapters/domains/src/quote/port.ts:63`) has no owner counterpart.
- **Issue UNKNOWN** → `GET /v1/quotes/:id`: `issued` ⇒ applied; `draft` ⇒
  re-send issue with the same key and `expectedVersion` from the create
  snapshot (1). If the key is stuck `in_progress` (owner crashed mid-render)
  ⇒ 409 forever: re-issue with a **new derived key** is safe because the
  version guard prevents double issue. This is the only path that needs a
  second key and must be modeled explicitly.
- Replay returns the snapshot at completion time; R4 must `GET` the quote for
  current state before telling the customer anything about status.

Conclusion: `quote.create` can participate correctly in R4 reconciliation.
**Not a blocker**, but R4's recovery for this capability changes from
`reconcile_before_retry` with lookup to "replay frozen request + read state".

---

## Q. Database model

Schema `quote_service` (migrations `000001`–`000005`):

| Table | PK | Key columns | Constraints / FKs |
|---|---|---|---|
| `quotes` | `quote_id uuid` | `quote_number text` (unique), `opportunity_id text NOT NULL`, `customer_id`, `conversation_id`, `actor_type/id`, `source_system`, `source_correlation_id`, `status`, `currency`, `customer_snapshot jsonb`, `subtotal/tax_amount/total numeric(20,0)`, `valid_until timestamptz`, `version`, revision ids, `issued_*` (hash, render version, storage keys, sha256, generated_at), lifecycle timestamps | status/actor/source/currency/≥0 checks; self-FKs for revisions; unique partial `supersedes_quote_id`; indexes opportunity_id, status, revision_root_id, valid_until (`000002…:20-227`) |
| `quote_lines` | `line_id uuid` | `quote_id` FK cascade, `display_order` (unique per quote), `type`, `external_source/item_id/variant_id`, `sku`, `description`, `quantity numeric(20,6)`, `unit_price numeric(20,0)`, `tax_included`, `tax_rate numeric(20,6)`, `line_subtotal/tax/total numeric(20,0)` | type ∈ product/service/shipping; positivity checks (`000002…:229-330`, `000004`, `000005`) |
| `idempotency_keys` | `(idempotency_key, operation_name)` | `resource_type/id`, `request_hash`, `status`, `response_code`, `response_body_snapshot jsonb`, `expires_at` | status check (`000002…:332-386`) |
| `quote_audit_events` | `audit_event_id uuid` | `quote_id` FK, `quote_number`, `action`, from/to status, actor, source, `correlation_id`, `idempotency_key`, `event_at`, `payload_snapshot jsonb` | action check (12 values, `000003…:13-42`) |
| `quote_deliveries` | `delivery_id uuid` | quote FK, channel `email`, `recipient`, status, attempts, provider message id, failure, actor/source, timestamps | `000003…:44-133` |
| `quote_email_outbox` | `outbox_id uuid` | delivery FK (unique), status, attempts, `next_attempt_at`, `locked_at` | `000003…:135-203` |
| `quote_number_seq` | sequence | — | `000002…:18` |

No external-execution-id column; the only caller reference slots are
`opportunity_id`, `customer_id`, `conversation_id`, `source_correlation_id`.
No customer PII was read (the production database does not exist).

---

## R. Audit trail

| Event | Recorded? | Action | Evidence |
|---|---|---|---|
| creation | yes | `draft_created` | `quote-service.ts:264-282` |
| draft edit | yes | `draft_updated` | `quote-service.ts:311-329` |
| issue | yes (with hashes) | `issued` | `quote-service.ts:674-696` |
| send | yes | `email_delivery_requested/sent/failed/retry_scheduled` | `quote-delivery-service.ts:212-228`; worker |
| cancellation / expiration / accept / paid | yes | `cancelled/expired/accepted/paid` | `quote-service.ts:732-767`, `:579-594` |
| revision | yes, on both quotes | `revision_created` | `quote-service.ts:492-527` |
| failures (create/issue) | **no** (rolled back; issue only marks idempotency `failed`) | — | `quote-service.ts:709-729` |

Caller metadata preserved without modification: `actor{type ∈ sales_agent,
operator, system, service; id ≤200}`, `source{system ∈ crm_customer_360,
manual, api, scheduler; correlationId ≤200}`, `idempotency_key` (stored on
the audit row, **not exposed** by `GET /audit`, `quote-presenter.ts:151-170`).
For R4: `actor = {type:"sales_agent", id:<agent/run ref>}`, `source.system =
"api"` (no `r4` value exists), `source.correlationId = executionKey` (or the
task correlation id — only one slot), `conversationId = R4 task/conversation
id`. Approver identity cannot be carried except by choosing it as
`actor.id` — R4's own receipts remain the governance record.

---

## S. Auth / security

- One shared static bearer token for all callers; no per-caller identity or
  authorization model (`service-auth.ts`). Weak tokens rejected in production
  (`env.ts:98-126`). R4 would need its own copy of the token (new secret).
- No TLS; listens on all interfaces in prod (172.31.1.183:3011). Must stay on
  localhost / private network (security group not audited).
- No CORS (server-to-server).
- PII: customer snapshot stored in jsonb; error responses sanitized
  (`errors.ts:178-182`, README); request logs are Fastify defaults (method,
  url, status — no bodies); delivery audit masks recipients.
- Documents: refs are HMAC-signed (`QUOTE_DOCUMENT_REF_SECRET`), bound to
  quoteId + contentHash, and download still requires the bearer token — not
  guessable, not public.
- quoteId is a random UUID; quote numbers are sequential/guessable
  (`GET /by-number`), but every read needs the token.

---

## T. Observability

- Structured pino JSON logs with `service`, request id (Fastify `reqId`),
  method/url/status; errors ≥500 logged with stack, 4xx as warn with `code`
  (`errors.ts:185-210`).
- No correlation-id propagation from headers; correlation only via
  `source.correlationId` in the body → stored on quote and audit rows.
- No metrics endpoint. `/health` (DB) and `/health/ready` (DB + storage +
  renderer + lifecycle) (`health-route.ts`, `readiness-service.ts`).
- Background jobs log per iteration (`background-job-manager.ts:51-58,81-88`).
- Usable R4 provenance/reconciliation evidence: `quoteId`, `quoteNumber`,
  `version`, `status`, `pricing.total`, `validUntil`, `timestamps.*`,
  `issuedDocument.contentHash/pdf.sha256`, `source.correlationId`,
  audit events by quoteId.

---

## U. Performance characteristics

No production traffic exists to measure. From code/docs: create/read are a
handful of indexed single-row queries inside one transaction (no external
calls); issue adds pdfmake render ≈ 50–115 ms single, ≈ 380 ms with 10
concurrent (`docs/quote-r1-t07d…:184-204`) plus three file writes; email
latency is decoupled (worker interval 30 s default + Gmail). Server request
timeout 15 s, DB query timeout 15 s (`env.ts:39,48`). CRM client used a 5 s
timeout (`CRM:lib/integrations/quote-service/config.ts:15`). R4's capability
timeout today is 20 s (`R4:agents/sales/src/capabilities/quote.ts:74`) —
sufficient for create + issue.

---

## V. Existing R4 Quote contract vs owner contract

R4 today: `QuoteService.create(request, idempotencyKey)` /
`findByIdempotencyKey` (`R4:adapters/domains/src/quote/port.ts:61-64`),
fixture + shadow owners, `quote.create` capability v1
(`R4:agents/sales/src/capabilities/quote.ts`), workspace tables
`sales.quote_requests` / `sales.quote_references`
(`R4:agents/sales/migrations/0006_sales_reference_application.sql:54,66`).

| # | R4 assumption | Real owner | Severity |
|---|---|---|---|
| 1 | Owner prices lines from current catalog and computes shipping; callers "never send amounts" (`port.ts:3-8`, `fixture.ts:85-101`) | Caller sends unit price, tax flag/rate, shipping line; owner only does arithmetic | **Fundamental** |
| 2 | Request = `{customer, lines: ItemQuantity[], delivery{commune,region}}` | `opportunityId`, `actor`, `source`, `currency`, `customerSnapshot`, priced `items[]`, `validUntil` | **Fundamental** |
| 3 | One call returns `status:'issued'` with `documentRef` | Create returns `draft` with no document; issue is a second call | **Fundamental** |
| 4 | `findByIdempotencyKey` exists | No lookup by key; reconcile by replay | **Fundamental** |
| 5 | `validUntil` = owner-computed (fixture: issuedAt + **7 days**, `fixture.ts:18`) | Caller-supplied; store copy says 5 days | **Fundamental** |
| 6 | Quote number `COT-1000xx` | `PC-000001` | cosmetic |
| 7 | Owner rejects `missing_contact`, `unknown_product`, `product_unavailable`, `insufficient_stock`, `destination_not_serviceable` (`fixture.ts:87-101`) | None of these exist; owner validates only shape/positivity | High: R4 must enforce sellability/stock itself before proposing (or accept the owner does not) |
| 8 | `Quote.shipping {serviceLevel:'standard', commune, amount}`, `subtotal`, `total` as `Money` numbers | shipping is a line; `pricing{subtotal(net),taxAmount,total}` decimal strings | High |
| 9 | Owner errors arrive as `rejected` with domain codes; `temporarily_unavailable` ⇒ no effect | 409 idempotency/version conflicts, 503 document failures (create may have succeeded before an issue 503) | High |
| 10 | `quote.create` input requires email or phone (`quote.ts:15-24`) | Owner requires only `name` | Medium |
| 11 | Workspace delivery (commune) is enough for shipping | A chosen carrier offer (net amount) is needed; workspace cannot hold it | High (R4 gap) |
| 12 | `QuoteCreateOutput.lines[].productId` = R4 itemKey | Owner returns `externalItemId/externalVariantId` (PrestaShop ids) and its own `lineId` | Medium |
| 13 | Sales instructions: "quote numbers, totals and validity come only from that observation" (`sales.v4.agent.json:7`) | Compatible — keep | OK |
| 14 | Production policy `quote.create → REQUIRE_APPROVAL` (`R4:agents/sales/src/production/profile.ts:44,61`), bound in prod composition (`R4:agents/sales/src/production/composition.ts:143`); quote domain `UNAVAILABLE` and capability unregistered in v1–v3 (`composition.ts:126`) | — | **Verified true** |
| 15 | Reference (non-prod) policy `quote.create → allow` (`R4:agents/sales/src/policy.ts:20`) | — | Must never reach production |

Per the instruction "do not preserve incorrect fixture semantics", the port,
fixture, shadow owner and capability output schema must be redesigned for J3,
not adapted.

---

## W. Governance boundary

Intended production path (unchanged principle; current code already does
everything up to the executor):

```
Model ── propose_action(quote.create, {workspaceVersion, customer…})
  ▼
ActionProposal ── Policy Engine (sales-production-policy v1: REQUIRE_APPROVAL,
  ▼                minimumIdentity provisional, requireEvidence) — verified
Human approval
  ▼
ActionExecution (executionKey = r4x_<executionId>, args frozen;
  ▼               R4:packages/task-runtime/src/action-runtime.ts:352-372,844-846)
Quote production adapter
  1. resolve owner request from workspace@version + Catalog item contexts
     + chosen shipping offer + customer; FREEZE it durably under executionKey
  2. POST /v1/quotes            (Idempotency-Key = executionKey)
  3. POST /v1/quotes/:id/issue  (Idempotency-Key = executionKey, expectedVersion 1)
  ▼
Quote Service ── receipt from owner response (issued quote)
```

What the approver must see: the frozen owner request (lines with unit prices
and quantities, shipping line, customer name/contact, `validUntil`) and the
expected total, not just "create a quote". Today the request is resolved at
execution time, *after* approval (`R4:agents/sales/src/capabilities/quote.ts:83-93`).
With prices now forwarded by R4, J3 must decide whether (a) the request is
resolved and frozen at proposal time and shown to the approver (executor
re-validates that the Catalog evidence is still fresh and fails closed
otherwise — a deterministic check, not a semantic judge), or (b) it is
resolved at execution time and the approval covers "the workspace at version
N at current prices". (a) is recommended. Owner idempotency never replaces
Governance.

---

## X. Recommended minimal R4 action surface

| Option | Assessment |
|---|---|
| A `quote.create` = owner create only | Leaves a mutable `draft` without PDF; customer-facing number with no document; validity and expiry not applicable to drafts. Not enough for the Sales flow. |
| B `quote.create` + `quote.issue` | Two approvals for one business act; drafts are invisible to the customer, so splitting adds friction without a decision point. |
| C `quote.create` + `quote.send` + `quote.cancel` | `send` = real outbound email (correctly separate) but not needed for the first slice; `cancel` not needed. |
| **D (recommended)** `quote.create` = **owner create-draft + issue**, one governed IRREVERSIBLE_WRITE, two idempotent owner calls | The smallest action producing the thing the customer understands as "una cotización" (number, total, validity, PDF exists). Partial state (draft created, issue failed) is internal and recoverable. |

Later, separately governed: `quote.send_email` (outbound, needs recipient
email, REQUIRE_APPROVAL), PDF delivery over WhatsApp (channel work),
`quote.get` (read). Not exposed in J3: update draft, accept, mark-paid,
cancel, expire, revisions.

---

## Y. Required source for every input field

| Owner field | Intended R4 source |
|---|---|
| `opportunityId` (required) | **Decision needed (Z3)** — proposal: R4 Sales task/conversation ref, e.g. `r4:sales:<taskId>` |
| `customerId` | omitted (J4) |
| `conversationId` | R4 conversation/task id |
| `actor` | R4 adapter constant `{type:"sales_agent", id:"r4-sales"}` (or agent id) |
| `source` | `{system:"api", correlationId: executionKey}` |
| `currency` | constant `CLP` (Catalog reports CLP) |
| `customerSnapshot.name` | Human input via conversation (model proposal arg, validated) |
| `customerSnapshot.email/phone` | Human input; phone may default to the WhatsApp sender id (channel identity) |
| `customerSnapshot.district/region` | SalesWorkspace delivery destination |
| `customerSnapshot.address`, `businessName` | Human input, optional (not needed) |
| line `type` | adapter: `product` / `shipping` |
| line `externalSource/ItemId/VariantId` | Catalog (`ref.productId`, `ref.variantId`) |
| line `sku` | Catalog (`variant.sku ?? parentProduct.sku`) |
| line `description` | Catalog (`parentProduct.name` + variant attributes) |
| line `quantity` | SalesWorkspace |
| line `unitPrice`, `taxIncluded`, `taxRate` | Catalog `getItemContext(itemKey, quantity).pricing` (`finalGross`, `true`, `tax.rate`) |
| shipping line `unitPrice` | Shipping offer `price.ownerNet` (`taxIncluded:false`, `taxRate:0.19` per ADR-032 policy) |
| shipping line `description` | Shipping offer `carrierName` + commune |
| chosen shipping offer | **Customer choice, recorded in SalesWorkspace (missing today)** |
| `validUntil` (required) | **Decision needed (Z2)** |
| quote number, quoteId, totals, tax, status, issuedAt, documents | Quote Service |
| `Idempotency-Key` | R4 `executionKey` |
| `expectedVersion` (issue) | Quote Service create response (`version`) |

Minimum success evidence before any customer claim (owner principle +
`sales.v4.agent.json` instruction): HTTP 2xx from **issue** whose body has
`quoteId`, `quoteNumber`, `status ∈ {issued}`, `pricing.total`,
`validUntil`, `timestamps.issuedAt`, `issuedDocument.available=true` and
`pdf.sha256`. A 201 from create alone (status `draft`) is not evidence of a
quote for the customer. No PDF URL exists to claim.

Read capability (`quote.get`): **NOT NEEDED for J3 reconciliation** (adapter
calls `GET /v1/quotes/:id` internally, no model exposure); **USEFUL LATER**
for follow-up questions and status checks after J3.

---

## Z. J3 implementation blockers

| # | Blocker | Kind | Owner of the fix |
|---|---|---|---|
| **Z1** | Production Quote Service is not running: pm2 `stopped` (2595 restarts), last start attempts 2026-09-16 failed "Database is not reachable during startup validation"; no Quote Service Postgres on the host; nothing on :3011. Deployed code `b504f75` is otherwise current | **NOT SUPPORTED / BLOCKER** (owner ops: provision DB, run migrations, configure `SERVICE_AUTH_TOKEN`, `QUOTE_DOCUMENT_*`, persistent storage dir, restart; email provider decision) | Quote Service operator |
| **Z2** | Validity is caller-supplied; Quote Service does not own the 5-day policy. Either the owner computes `validUntil` (OPTIONAL OWNER IMPROVEMENT that would remove R4 from validity), or R4 applies the store's approved 5-day policy as an explicit, versioned adapter policy (like `SHIPPING_VAT_POLICY`), frozen at request time. Also decide end-of-day/timezone (PDF shows UTC date) | **Decision** (product/architecture) | User |
| **Z3** | `opportunityId` is required and R4 has no opportunity. Proposal: opaque `r4:sales:<taskId>`; must not collide with CRM numeric ids | **Decision** | User |
| Z4 | Expiration scheduler default OFF in config; production value unknown (service down) | Ops config, not a correctness blocker for create | Quote Service operator |
| Z5 | R4 has no durable "chosen shipping offer" — required to put shipping on a quote; without it J3 can only produce product-only quotes | R4 work (workspace op) | R4 |

Classification of requirements:

| Requirement | Classification |
|---|---|
| Create quote from resolved snapshot | SUPPORTED AS-IS |
| Separate issue with PDF | SUPPORTED AS-IS |
| Shipping on the quote | SUPPORTED VIA R4 ADAPTER (shipping line, net + 0.19) |
| Catalog-priced product lines | SUPPORTED VIA R4 ADAPTER |
| Idempotent create keyed by executionKey | SUPPORTED AS-IS (requires frozen body) |
| Unknown-outcome reconciliation | SUPPORTED VIA R4 ADAPTER (replay + GET) |
| Lookup by idempotency key | NOT SUPPORTED — not needed |
| Owner-owned validity | NOT SUPPORTED — decision Z2 |
| Guest customer | SUPPORTED AS-IS (name only) |
| Actor/correlation provenance | SUPPORTED VIA R4 ADAPTER (`source.system="api"`) |
| Running production owner | **BLOCKER Z1** |

OPTIONAL OWNER IMPROVEMENTS (not required): server-side default `validUntil`
from a configured policy; `GET` by idempotency key or by
`source.correlationId`; an `r4` value in `SOURCE_SYSTEMS`; lease/timeout for
stuck `in_progress` issue keys; `idempotencyKey` in the audit DTO; Chile
timezone date rendering; quote number width beyond 6 digits; render
"Precios incluyen IVA" from line flags.

---

## AA. Proposed J3 implementation slices

Each slice needs explicit authorization; none advances a roadmap phase by
itself.

- **J3B — Port & adapter redesign (no production).** New `QuotePort`
  modeled on the real contract (create draft, issue, get), HTTP adapter
  (`@r4-adapters/quote-http`) with the frozen-request discipline, error
  mapping (409 idempotency/version, 503 documents, timeouts ⇒ unknown),
  replace fixture and shadow owner with real-contract semantics (Model B,
  draft→issued, `PC-` numbers, no owner pricing). Contract tests against a
  disposable Postgres running the real Quote Service (local Docker), never
  production. ADR-033.
- **J3C — Sales `quote.create` v2.** Request resolution from workspace +
  Catalog item contexts + chosen shipping offer + customer name; workspace
  operation to record the customer's chosen carrier offer (Z5); validity
  policy per Z2; `opportunityId` per Z3; recovery = replay frozen request +
  state read; output schema = owner numbers (`quoteNumber`, `pricing.*`,
  `validUntil`, `status`, document hash); approval payload shows the frozen
  request (W). Evaluations: no claim before `issued` evidence, no duplicate
  per execution key, retry after crash windows (create committed / issue
  stuck), price-drift fail-closed. Sales definition version bump.
- **J3D — Owner production readiness (owner ops, user-run).** Provision the
  Quote Service DB, migrations, secrets, storage volume, restart, read-only
  health verification; keep `QUOTE_EMAIL_PROVIDER=disabled` until a send
  action exists; decide expiration scheduler.
- **J3E — Production activation.** `sales-production@4`: Quote domain REAL,
  `quote.create` registered with `REQUIRE_APPROVAL` unchanged, worker
  binding + secret, canary E2E with one approved quote on the canary number,
  rollout doc.
- **Later (not J3):** `quote.send_email` (approval-gated outbound),
  PDF over WhatsApp, `quote.get` read capability, revisions.
