# R4-J1D Step 5 (R1 rerun) — Verdict, 2026-09-30T18:15–18:25Z

Deployed: Catalog `fea0dc552b28137391b5757b23572e67196c7e14` (`catalog-commercial-v2.2.0`), config
SHOP_ID=1 / TAX_RATE=0.19 / PRESTASHOP_TIMEZONE=America/Santiago, health live 200 / ready 200 `ok`,
all capabilities `ok`, same snapshots.

**v2 pricing (R4's contract): PRICING_CONTRADICTION → RESOLVED** — 20/20 boundary units equal the
storefront (was 1/20); normal samples equal (P545, P2248, P2128 from, P1136 from −30 %, P2338 −50 %).

**Second path (commercial truth: `/api/v2/catalog/resolve-product-intent`, recommendations): 0/20.**
It returns the regular price for every promoted unit because `specificPriceSelector.parseDate` treats
mysql2's `Invalid Date` for `0000-00-00` as an invalid window and drops every current promotion. Selector,
reader and pool are unchanged since pre-J1D `7a214f4` — pre-existing, same class as
CAT-HOTFIX-V1-ZERO-DATE-PROMOTIONS; the R1 calculator on that path is proven by unit tests (20/20) but
is never given a reduction live. Not consumed by R4 (CRM only).

Everything else PASS: search (BORE20, kettlebell 20 kg, disco 10 kg, banco ajustable), Gold v0 (all hard
classes 100 %, deterministic), product/item context, typed errors, categories, OD-1, OD-2, OD-3, sellability,
legacy routes 200 with no new regression, performance (broad search ~1.2 s), logs 0 warn/error, 0 5xx.
An operator-issued graceful restart at 18:18:37Z (not by this task) did not affect results.

**Strict verdict against the task's gate (40/40 two-path parity): NOT_READY_FOR_R4 — decision required.**
