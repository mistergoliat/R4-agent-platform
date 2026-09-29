# Catalog contract fixtures — TEMPORARY (R4-J1B)

These JSON files are wire responses of the Catalog read contract, `schemaVersion: 1`
(`docs/architecture/R4-J1B_CATALOG_CONSUMER_IMPLEMENTATION.md` §2), written by R4 while
catalog-service implements the contract (R4-J1A). They are synthetic: example keys
(`P898`, `P1301-V16`), example prices, no real catalog data.

They are **temporary**. When catalog-service publishes its own contract fixtures:

1. copy the owner's files here, unchanged, and record the owner commit they came from;
2. delete every R4-authored file they supersede;
3. keep one definition only — R4 never maintains a second, divergent copy of the contract.

`tests/contract/catalog-http-contract.test.ts` validates every file here against the
adapter's schemas; `tests/unit/catalog-http/adapter.test.ts` serves them over a fake
transport.

| Endpoint | Files |
|---|---|
| `POST /v2/catalog/search` | `search/exact-name`, `exact-sku` (stock 0, still found), `product-with-variants`, `no-stock-present`, `empty-complete`, `truncated` |
| `GET /v2/catalog/products/{productKey}/context` | `product/simple` (specifications, FBT available), `with-variants` (FBT unavailable), `inactive`, `not-found`, `not-listed` |
| `GET /v2/catalog/items/{itemKey}/context?quantity=N` | `item/simple`, `selected-variant`, `promotion`, `not-sellable`, `backorder`, `stock-unknown`, `pricing-unavailable`, `variant-required`, `not-found` |
