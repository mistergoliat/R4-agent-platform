# R4-J1 — Final durable WhatsApp E2E audit (read-only, 2026-09-30)

Session: allowlisted identity (conversation key `8776ac97…`), 8 real inbound messages 19:07:26–19:11:41Z
(1 greeting + the 7 J1 cases, paraphrased by the sender), one conversation binding `01a0ee77-53b1…`
(opened 2026-09-29 under `sales-production@1`), task `01a0ee77-53b5…`, runs 3–8. Evidence: `trace.json`
(sanitized: no phone, no keys), `latency.json`.

**Verdict: R4-J1 CATALOG — NOT CLOSED.**

## Blockers

1. **Runtime is sales@1, not sales@2.** The session continued the conversation opened on 2026-09-29;
   its task is pinned to `agent_version = 1` and all six runs ran `sales@1` (sales@2 was registered at
   19:01:41Z but only new tasks resolve it). The worker itself was `sales-production@2` (Catalog REAL).
2. **NOT_GROUNDED commercial claim (case 3).** "hay 24 kg $67.990" presented the 24 kg kettlebell as
   available; the backing observation (19:09:40Z) says P187 `not_sellable/out_of_stock`.
3. **STALE commercial claims.** Claims sent after the backing observation's `valid_until` (owner asOf + 15 s)
   without a refresh: case 5 delivered answer (P2128 observation expired 19:10:40.8Z, claim 19:11:01.9Z,
   +21 s); last turn: colchoneta (expired 19:12:19.5Z, claim 19:12:30.3Z, +11 s) and collarines (observed
   19:10:25Z, claim 19:12:30Z, ≈+110 s); greeting turn: mancuernas (+8 s). Latency from last observation to
   response is 4.6–14.9 s, so a 15 s owner window is routinely exceeded and nothing refreshes or guards it.
4. **Model-computed price arithmetic.** "Total referencial ~$181.985" (greeting) and "Sumados quedan
   ~$22.286" (last turn) are totals computed by the model, not Catalog evidence.

## Cases

| Case | Inbound (text) | Run | Agent | Catalog calls | Grounding | Freshness | Outbound | Delivery | Result |
|---|---|---|---|---|---|---|---|---|---|
| 1 BORE20 | 19:08:56 "tienen bore20?" | 4 | sales@1 | search `bore20` → P545 | GROUNDED (P545, $84.990, sellable) | FRESH (claim 19:09:12.8 ≤ 19:09:16.3) | accepted | delivered, read | PASS* |
| 2 price | 19:09:22 "cuanto vale" | 5 | sales@1 | product_context P545 | GROUNDED ($84.990, in stock) | REFRESHED (claim 19:09:29.8 ≤ 19:09:39.9) | accepted | delivered, read | PASS* |
| 3 kettlebell 20 | 19:09:30 "tienen kettlebell de 20?" | 6 | sales@1 | search `kettlebell` | 20 kg P186 $56.990 GROUNDED; **24 kg "hay" NOT_GROUNDED** | FRESH | accepted | delivered, read | **FAIL** |
| 4 disco 10 kg | 19:09:32 "discos de 10 kg?" | 6 | sales@1 | search `disco 10 kg` | GROUNDED (P145 $45.990, P1497 $47.990, no 110 kg) | FRESH | (same reply as 3) | delivered, read | PASS* |
| 5 collarines | 19:10:18 "…collarines olímpicos magnéticos rising…" | 7 | sales@1 | search `collarines`, product_context P2128 | GROUNDED (from $15.990, Rosado/Amarillo asked, no variant assumed) | **STALE** (+21 s) | 1st reply cancelled `superseded_by_newer_input` (by design); 2nd accepted | read (no delivered event) | **FAIL** |
| 6 colchoneta 2da | 19:10:38 "cuanto cuesta la colchoneta oxford de segunda" | 7 | sales@1 | search `colchoneta oxford` | GROUNDED (P2340 $6.296, regular $13.990) | FRESH (claim 19:11:01.9 ≤ 19:11:06.9) | accepted | read (no delivered event) | PASS* |
| 7 Air Bike | 19:11:41 "…Cotizame aparte una air bike hurricane" | 8 | sales@1 | search `air bike hurricane`, product_context P2340, P2297 | Air Bike GROUNDED (not_sellable/out_of_stock, $899.990 reference, no quote, no stock invented); same message: model total ~$22.286 NOT_GROUNDED | Air Bike FRESH (19:12:30.3 ≤ 19:12:30.4); colchoneta/collarines **STALE** | accepted | delivered, read | PASS* (air bike) — turn has blockers 3/4 |

\* Catalog behaviour correct, but every turn ran on `sales@1` (blocker 1).

## Other gates

- Catalog v2 only: 13 capability invocations (`catalog.search` ×9, `catalog.get_product_context` ×4) through
  the HTTP adapter (`catalog.call` ×13 ok, 10–650 ms); Catalog received only `/v2/catalog/*` (13 × 200) in
  the window; no v1, no commercial-truth route, no fixture, no mock. **PASS.**
- Durability: 8 inbound (0 duplicates, all settled `autonomous`) → 8 task inputs → 6 runs (all
  `suspended/waiting`, no failure) → 26 steps recorded → 13 invocations = 13 observations → 7 outbound
  (6 accepted with provider id, 1 cancelled superseded, 0 duplicates, 0 failed attempts); 0 write proposals.
  **PASS.**
- Outbound: 6/6 sent messages accepted and read; 5 with a delivered event, 1 read without delivered event
  (PASS_WITH_TELEMETRY_GAP). **PASS.**
- Logs 19:04–19:13Z: worker 818 info, gateway 91 info, 0 warn/error; Catalog 26 info, 0 5xx. **PASS.**
- Latency (baseline for J6): inbound→run 91–4 336 ms; run→first Catalog call 1.6–6.6 s; Catalog call
  10–650 ms; last observation→response 4.6–14.9 s; inbound→provider accepted 8.3–49.4 s.

## Nonblocking

- Workspace not updated ("Anoto lo que me pides" with 0 write proposals); the reply then asks for
  confirmation, so no false effect was claimed.
- Greeting turn offered unrequested products with a model-computed total.

## To close

1. Run the E2E in a **new conversation** that resolves `sales@2` (close/cancel the 2026-09-29 conversation with
   the production control, or use a fresh allowlisted identity).
2. Decide and implement the freshness remedy (R4 side): refresh-or-withhold commercial claims whose evidence
   expired before sending, and forbid model-computed totals/availability not present in evidence — then rerun.
