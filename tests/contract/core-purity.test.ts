import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * R4 Core must not know domain, channel, CRM or vendor concepts (AGENTS.md,
 * PRD §44). This scans every Core source file, migration and the HTTP app.
 * Historical/architecture docs are intentionally out of scope.
 */
const FORBIDDEN_TERMS = [
  'quote',
  'cart',
  'opportunit(y|ies)',
  'campaign',
  'product',
  'payment',
  'commercial\\w*',
  'follow-?up',
  'sales',
  'whatsapp',
  'crm',
  'customer',
  'catalog(ue)?',
  'deepseek',
  'openai',
  'anthropic',
  'claude',
  'gpt',
  'gemini',
  'next\\.?js',
  'react',
];

const SCANNED_ROOTS = ['packages', 'apps'];
const SCANNED_EXTENSIONS = ['.ts', '.sql', '.json'];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.endsWith('.tsbuildinfo')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(path);
  }
  return out;
}

describe('Core purity', () => {
  const sources = SCANNED_ROOTS.flatMap((root) => files(join(ROOT, root)));

  it('scans a non-trivial set of Core files', () => {
    expect(sources.length).toBeGreaterThan(30);
  });

  it('contains zero domain, channel, CRM or vendor terms', () => {
    const pattern = new RegExp(`\\b(${FORBIDDEN_TERMS.join('|')})\\b`, 'i');
    const violations: string[] = [];
    for (const file of sources) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const match = pattern.exec(line);
          if (match) violations.push(`${relative(ROOT, file)}:${index + 1}: "${match[0]}"`);
        });
    }
    expect(violations).toEqual([]);
  });

  it('keeps agent packs out of Core packages', () => {
    const packages = readdirSync(join(ROOT, 'packages'));
    for (const name of packages) expect(name).not.toMatch(new RegExp(FORBIDDEN_TERMS.join('|'), 'i'));
  });
});
