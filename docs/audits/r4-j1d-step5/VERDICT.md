# R4-J1D Step 5 — Verdict (rerun, 2026-09-30T17:06–17:25Z)

**NOT_READY_FOR_R4 — PRICING_CONTRADICTION (blocking).**

Catalog J1D (`47875d5`, `catalog-commercial-v2.1.0`) returns, for currently discounted units whose
price falls on a rounding boundary, a final price **1 CLP below the storefront**:

- the 20 known "−1 CLP" units: storefront = J1D in **1/20** (P2264), storefront = legacy rounding in **19/20**
  (P382, P435, P1415, P1927, P1928, P1930, P1931, P1935, P1936, P1937, P1939, P1944, P1948, P2195,
  P2317, P2319, P2328, P2337, P2340);
- all non-boundary samples match (P545, P2248, P2128, P1136, P2338, P2264).

The J1D "rounding correction" is therefore not a correction: PrestaShop's storefront rounds the
tax-included price before applying the percentage. A 5-decimal intermediate rounding reproduces
20/20 storefront values (hypothesis for the Catalog fix; not implemented here).

Everything else passed: deploy identity/config, health (all capabilities ok), legacy sanity (no
5xx, shapes intact), /v2 routes, Gold v0 live (all hard classes 100 %), product/item context,
typed errors, category, OD-1 (limited live coverage), OD-2 shape, OD-3 freshness, sellability,
performance (broad search ~1.2 s), post-smoke logs clean.

Next: RETURN_TO_CATALOG_FIX — align commercialEngine (and CommercialPriceCalculator) with the
storefront rounding, re-freeze fixtures, redeploy, rerun Step 5. R4 is not connected.
