# Catalog contract fixtures — OWNER COPIES (R4-J1C)

Every JSON file here except `SOURCE.json` is an **unchanged copy** of the fixtures published by
the Catalog owner (catalog-service `contracts/catalog/v2/fixtures/`), `schemaVersion: 1`. The owner
generates them from its real service and HTTP app and pins them in `MANIFEST.json`
(`sha256(JSON.stringify(JSON.parse(file)))`, line-ending independent).

R4 authors no fixture. To update, run from the repository root:

```sh
node scripts/sync-catalog-fixtures.mjs <path-to-MS-pesaschile-catalog-service>
```

The script copies the manifest's files byte-for-byte, verifies each hash, deletes any other fixture
here and writes `SOURCE.json` (owner commit, and whether the owner's contract files had uncommitted
changes at copy time). Never edit a fixture by hand: `tests/contract/catalog-http-contract.test.ts`
fails when a file here does not match the owner manifest, or when a file is not in it.

`tests/unit/catalog-http/adapter.test.ts` serves these files over a fake transport; the real-HTTP
integration against a running catalog-service is `tests/integration/catalog-http-real.test.ts`.
