import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pinnedContract } from '@r4-adapters/customer-http';

// R4-J4-R3 (R3.3): the Customer Profile adapter's runtime contract moves to v1-rc2, copied byte for
// byte from MS-pesaschile-customer-profile main @ bbd766e (CP-S5 merged). v1-rc1 (47db415) stays
// pinned in contract/ and fixtures/ as R2 regression evidence (customer-http-contract.test.ts).

const PACKAGE = join(import.meta.dirname, '..', '..', 'adapters', 'domains', 'customer', 'http');
const RC2 = join(PACKAGE, 'contract-v1-rc2');
type Entry = { file: string; ownerPath: string; gitBlob: string; sha256: string; contentSha256: string };
const SOURCE = JSON.parse(readFileSync(join(RC2, 'SOURCE.json'), 'utf8')) as { ownerCommit: string; revision: string; files: Entry[] };
const lf = (path: string) => Buffer.from(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'), 'utf8');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = (path: string) => JSON.parse(lf(path).toString('utf8')) as Record<string, unknown>;

/** Drops human text and the added error code, leaving the validation structure (owner rc2 test rule). */
function structure(node: unknown): unknown {
  if (Array.isArray(node)) return node.filter((v) => v !== 'grant_rejected').map(structure);
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node as Record<string, unknown>).filter(([k]) => k !== 'title' && k !== 'description').map(([k, v]) => [k, structure(v)]));
  }
  return node;
}

describe('pinned v1-rc2 (provenance)', () => {
  it('records the owner commit and revision; every copied file is byte-identical to its owner blob', () => {
    expect(SOURCE).toMatchObject({ ownerCommit: 'bbd766ef4b32c0ceb1065f9b7791f63f46798ef9', revision: 'v1-rc2' });
    const copied = readdirSync(RC2, { recursive: true, withFileTypes: true }).filter((e) => e.isFile() && e.name !== 'SOURCE.json').map((e) => `contract-v1-rc2/${join(e.parentPath, e.name).slice(RC2.length + 1).replace(/\\/g, '/')}`).sort();
    expect(SOURCE.files.map((e) => e.file).sort()).toEqual(copied);
    for (const entry of SOURCE.files) {
      const bytes = lf(join(PACKAGE, entry.file));
      expect(sha256(bytes), entry.file).toBe(entry.sha256);
      expect(sha256(JSON.stringify(JSON.parse(bytes.toString('utf8')))), entry.file).toBe(entry.contentSha256);
      expect(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest('hex'), entry.file).toBe(entry.gitBlob);
    }
  });

  it('agrees with the owner SOURCE.json and MANIFEST (the hashes CP-D2-ACC-02 accepted)', () => {
    const owner = json(join(RC2, 'owner-SOURCE.json')) as { revision: string; schemas: { response: { sha256: string }; request: { sha256: string } }; manifestSha256: string };
    const content = (file: string) => SOURCE.files.find((e) => e.file === `contract-v1-rc2/${file}`)!.contentSha256;
    expect(owner.revision).toBe('v1-rc2');
    expect(content('customer-sales-context-v1.schema.json')).toBe(owner.schemas.response.sha256);
    expect(content('customer-sales-context-v1.schema.json')).toBe('fc29ea6bd1c6a6bd2978fc8a119cc3389207ca3587012530759ce3d2e8b6ea36');
    expect(content('customer-sales-context-request-v1.schema.json')).toBe(owner.schemas.request.sha256);
    expect(content('fixtures/MANIFEST.json')).toBe(owner.manifestSha256);
  });
});

describe('v1-rc1 → v1-rc2, reviewed exactly', () => {
  it('the request schema is content-identical; the response schema differs only in text and the grant_rejected code', () => {
    const rc1 = (file: string) => json(join(PACKAGE, 'contract', file));
    const rc2 = (file: string) => json(join(RC2, file));
    expect(rc2('customer-sales-context-request-v1.schema.json')).toEqual(rc1('customer-sales-context-request-v1.schema.json'));
    expect(structure(rc2('customer-sales-context-v1.schema.json'))).toEqual(structure(rc1('customer-sales-context-v1.schema.json')));
    expect(JSON.stringify(rc2('customer-sales-context-v1.schema.json')).split('"grant_rejected"').length - 1).toBe(1);
  });

  it('the runtime validator is the v1-rc2 one: 403 grant_rejected without reason is a valid error body, with reason it is not', () => {
    const { ownerCommit, revision } = pinnedContract();
    expect({ ownerCommit, revision }).toEqual({ ownerCommit: SOURCE.ownerCommit, revision: 'v1-rc2' });
    const ajvSchema = json(join(RC2, 'customer-sales-context-v1.schema.json')) as { $defs: { errorResponse: { properties: { error: { enum: string[] } } } } };
    expect(ajvSchema.$defs.errorResponse.properties.error.enum).toContain('grant_rejected');
    expect(json(join(RC2, 'fixtures', 'error-grant-rejected.json'))).toEqual({ error: 'grant_rejected' });
    expect(json(join(RC2, 'fixtures', 'error-grant-rejected-with-reason.invalid.json'))).toHaveProperty('reason');
  });
});
