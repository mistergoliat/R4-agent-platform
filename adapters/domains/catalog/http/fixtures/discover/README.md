# catalog.discover contract fixtures — OWNER ANSWERS (R4-DISCOVER-I1)

Every JSON file here was produced by the Catalog owner (catalog-service), not written by R4:

- the owner's real `OperationalDiscoverService` over its real J1 v2 commercial owner (in memory);
- the owner's **synthetic** agent catalog and index (`tests/contract/discover-agent/scenarios.ts`).

They are contract fixtures. They are not production data and not relevance gold.

| Path | Content |
|---|---|
| `scenarios/*.json` | The owner's 24 V1-B2 agent scenarios: request, HTTP answer as the route sends it (FAILED → 4xx/5xx), the owner reference consumer's expectations |
| `r4-multiturn/turn-*.json` | The consolidated request R4 sends at each turn of its five-turn case, with the owner's answer |
| `http-error-matrix.json` | The owner route's status/code/retryable tables (`catalogDiscoverRoute.ts`) |
| `request.schema.json`, `response.tolerant.schema.json` | The owner's executable contract as JSON Schema (`agentContract.ts`) |
| `MANIFEST.json` | Owner commit, contract revision, LF hashes of the owner's contract sources, `sha256(JSON.stringify(JSON.parse(file)))` of every file |

To regenerate, run from the catalog-service checkout (the script imports the owner's code by path and never writes there):

```sh
cd <MS-pesaschile-catalog-service>
npx tsx <R4>/scripts/catalog-discover/export-fixtures.mts <R4>/adapters/domains/catalog/http/fixtures/discover
```

Never edit a fixture by hand. `tests/contract/catalog-discover-contract.test.ts` fails when a file does not match the manifest, or when a file is not listed in it.

The cross-process test (`tests/integration/catalog-discover-owner-process.test.ts`, needs `R4_DISCOVER_OWNER_REPO`) checks that the owner's live HTTP app still answers what these files record.
