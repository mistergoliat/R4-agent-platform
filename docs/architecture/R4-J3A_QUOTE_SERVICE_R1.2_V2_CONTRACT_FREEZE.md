# Quote Service — R1.2 V2 Contract Freeze (pointer and R4 consumer notes)

**Status:** CONTRACT_FROZEN = YES (2026-10-04). Documentation only. This
document does not advance an R4 roadmap phase and does not authorize J3B.

The canonical contract is owned by the Quote Service and lives in its
repository (`E:\dev\codex\MS\MS-pesaschile-quote-service`, base `fade75d`,
directory `docs/v2/`):

| Artifact | File |
|---|---|
| Index | `docs/v2/README.md` |
| OpenAPI 3.1 | `docs/v2/openapi.yaml` |
| Domain contract | `docs/v2/QUOTE_V2_DOMAIN_CONTRACT.md` |
| State machine | `docs/v2/QUOTE_V2_STATE_MACHINE.md` |
| Idempotency, issuance recovery, reconciliation | `docs/v2/QUOTE_V2_IDEMPOTENCY_AND_RECOVERY.md` |
| Validity policy `cl-retail-5-calendar-days-v1` | `docs/v2/QUOTE_V2_VALIDITY_POLICY.md` |
| Principals and scopes | `docs/v2/QUOTE_V2_SECURITY_SCOPES.md` |
| V1 → V2 mapping, KEEP / CHANGE / DELETE | `docs/v2/QUOTE_V2_V1_MIGRATION.md` |
| Roadmap R1.3–R1.7 | `docs/v2/QUOTE_V2_ROADMAP.md` |
| Freeze record (decisions C1–C21, checklist, open items, validation) | `docs/v2/QUOTE_V2_CONTRACT_FREEZE.md` |
| Examples / tooling | `docs/v2/examples/` (34), `docs/v2/tools/` |

Inputs: [R4-J3A_QUOTE_OWNER_AUDIT.md](R4-J3A_QUOTE_OWNER_AUDIT.md),
[R4-J3A_QUOTE_SERVICE_R1.1_PRODUCTION_READINESS_AUDIT.md](R4-J3A_QUOTE_SERVICE_R1.1_PRODUCTION_READINESS_AUDIT.md).
The owner contract contains no R4 primitive; everything R4-specific is below.

## R4 consumer notes (for a later, separately authorized J3 slice)

These are consequences of the frozen owner contract, not changes to it.

1. **Action meaning.** `quote.create` maps to one owner call:
   `POST /v2/quotes` (create-and-issue). Success evidence for any customer
   claim is the owner representation with `status = issued`,
   `quoteNumber`, `totals`, `issuance.issuedAt`, `validity`,
   `document.available = true` and `document.pdfSha256`. `issuing` (HTTP 202)
   is not success; the adapter polls `GET /v2/operations/{id}`.
2. **Price freeze.** The ActionProposal must carry the exact owner request
   body (lines with Catalog unit amounts per quantity tier, the chosen
   Shipping offer as `shipping` with owner NET, `taxBasis = excluded`,
   `taxRate = "0.19"`, customer, correlation, `expectedTotals`). The human
   approves that body; ActionExecution sends exactly that body and never
   re-fetches prices. `expectedTotals` makes any drift fail closed
   (`422 arithmetic_mismatch`).
3. **Idempotency.** `ActionExecution.executionKey` → `Idempotency-Key` for
   operation `quote.create_and_issue` under the R4 principal. One execution
   key → at most one quote. UNKNOWN outcomes are reconciled by replaying the
   frozen body (or `GET /v2/idempotency/current`); the current R4 port's
   `findByIdempotencyKey` maps to that lookup.
4. **Correlation.** `externalCorrelation = {sourceSystem: "r4-sales",
   externalReferenceType: "task", externalReference: <taskId>,
   correlationId: <run/trace id>}`; `correlationId` is outside the
   fingerprint, so a new trace id on retry is safe.
5. **Validity.** R4 never sends validity. No R4 principal receives
   `quotes:validity:override` in J3.
6. **Scopes for the R4 Sales principal in J3:** `quotes:create`,
   `quotes:read`, `quotes:document:read`. Not: drafts, issue, cancel,
   override, email delivery, audit, `read:any`.
7. **Email.** Never part of `quote.create`. The owner email provider stays
   disabled; a future `quote.send_email` would be a separate governed action.
8. **Governance unchanged.** `quote.create` stays `REQUIRE_APPROVAL` in the
   production policy; owner idempotency does not replace governance.
9. **R4 work implied (not authorized here):** replace the R4 Quote port,
   fixture and shadow owner (Model A assumptions) with the V2 contract; add a
   durable "chosen shipping offer" to the Sales workspace; customer snapshot
   from conversation (guest allowed); evaluation for "no claim before issued
   evidence".

The owner readiness gate (R1.1 §X) still applies: J3B cannot start before the
Quote Service V2 is implemented (R1.3–R1.6), deployed and stable (R1.7).
