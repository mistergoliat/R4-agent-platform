# R4-J1 — Second WhatsApp E2E (sales@2, J1E) — interim verdict

Date: 2026-09-30, 20:45:58–20:52:06Z. R4 `3d566cd` (J1E `cb9d2f0` + snapshot fix), Catalog `fea0dc5`.
Evidence: `trace.json` (sanitized: message texts only, no identity refs, no keys), `latency.json`.

**Verdict: R4-J1 CATALOG — NOT CLOSED (J1E false degradations, see below).**

## Gates that PASS

| Gate | Evidence |
|---|---|
| New task, sales@2 | task `01a0f411-2176…`, `agent_version=2`; binding `sales-production@2` (fp `2430a3e0…`); all 9 runs v2; the pre-v2 task was cancelled with the production control and its binding closed `task_cancelled` |
| Catalog v2 only, REAL | only `catalog.search` / `catalog.get_product_context` through the HTTP adapter; no legacy route, fixture or mock |
| J1E revalidation | 21 `origin=platform` READs; revalidated replies recorded against their iteration's snapshot; no `internal_failure` |
| 0 contradictions / 0 stale claims sent | validator replayed on the 11 recorded replies: all `allow`, evidence valid ≥ 3 s past provider acceptance |
| Out-of-stock handling | Air Bike and Colchoneta 2da Selección (now `out_of_stock` in PrestaShop) reported as unavailable |
| Derived total | "Total referencial: $29.980" = $15.990 + $13.990, labelled referential, not a quote |
| Durability | inbound → input → run → steps coherent; every observation linked to its READ step; no duplicate outbound; 2 cancelled `superseded_by_newer_input` (by design); 1 run `invalid_structured_output` (empty model output) recovered by ADR-028 |
| Outbound | every sent reply accepted by Meta with message id, delivered and read (last one accepted) |

## Blocking defects (J1E, R4)

1. **Refresh inside the owner cache window.** Catalog serves a cached answer until its `validUntil`;
   a platform refresh issued while the evidence is still valid returns the same near-expiry validity
   (P2128 20:47:54 `cacheAge 12.8 s`; P872 20:49:27 / 20:50:59 `cacheAge 12.6 / 13.9 s`), which never
   satisfies the 3 s send margin → `response_authority_unverifiable` → safe degradation.
2. **Availability consistency too narrow.** The not-available qualifier is required in the same
   sentence as the amount; honest drafts ("…está a $6.296… Eso sí: ahora figura sin stock", "…no es una
   oferta válida mientras no haya stock") were refused → degradation.
3. **Repeated degradation.** Each new draft restarts the correction cycle, so one run could send the
   degradation more than once (3 degraded replies reached the customer in this session).

Customer impact: 3 × "Perdón, no pude confirmar el precio ni la disponibilidad actual…" instead of
grounded answers. No false commercial fact was sent.

## Latency (baseline for J6)

inbound→run 0.25–8.1 s; run→first Catalog call 1.0–15.6 s; platform refreshes per run 0–6;
inbound→provider accepted 6.1–27.3 s (113 s for the last turn, which included a refused draft and
four model READs).
