# R4-J1 Step 6 — R4 → production Catalog (2026-09-30)

- Catalog auth (18:42Z): `CATALOG_API_KEYS` = legacy key (retained) + dedicated R4 key; values never printed.
  Matrix: v2 legacy 200, v2 R4 200, v2 none 401, v2 wrong 401, v1 legacy (CRM) 200. Backups `.bak-r4j1-20260930T184230Z`.
- R4 deployed `9e7e3f6ce7f644c237f11930d47363eff5049d83` (from `4b99271`): `npm ci`, build, bootstrap `registered: sales@2`.
- R4 env (values redacted): `R4_CATALOG_BASE_URL=http://127.0.0.1:4010`, `R4_CATALOG_API_KEY` PRESENT, `R4_CATALOG_TIMEOUT_MS=2500`.
- Direct CatalogPort smoke on the EC2 host with the production config (`adapter-smoke.json`): exact SKU, multi-token,
  variants (`from`/`offerable`, no invented variant), concrete item (engine `catalog-commercial-v2.2.0`), promotion
  P2340 6 296 (= storefront), not_found ×2, variant_required, unauthorized → `DomainError unauthorized`, deadline →
  `DomainError deadline_exceeded` (retryable), owner-bounded `validUntil` (ADR-030). Zero-stock: P2297
  `not_sellable/out_of_stock`; P2338 now `inactive` (deactivated in PrestaShop 18:37Z, `date_upd` 15:37 local) —
  Catalog reflects live truth.
- Profile v2 enabled 19:04:03Z (`R4_PROD_POLICY_PROFILE=sales-production@2`, backup `.bak-r4j1-v2-20260930T190403Z`):
  worker `service.composed profile sales-production@2` (fingerprint `2430a3e0…`), presence `ready`
  `0008_worker_presence:sales-production@2`; gateway listening. Plan: Catalog REAL, `catalog.search` and
  `catalog.get_product_context` available, customer/shipping/quote unavailable; rollout 0 %, 1 allowlisted, smoke
  recipient eligible (allowlisted); kill switch released (unchanged).
