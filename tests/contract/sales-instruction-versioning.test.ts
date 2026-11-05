import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { definitionContentHash } from '@r4/agent-registry';
import { SALES_AGENT_DEFINITION_FILES, loadSalesAgentDefinition, type SalesAgentDefinitionVersion } from '@r4-sales/agent';
import { SALES_PRODUCTION_AGENT_VERSIONS } from '@r4-sales/agent/production';

/**
 * R4_SALES_INSTRUCTIONS_VERSIONING_REVIEW.md: the shipping promotion clause and the conversation block evaluated in
 * G-sem stay byte-exact and independent until their composition is decided, and no registered definition loses them.
 * Instruction hashes are compared, not definition hashes: renumbering changes the version and description only.
 */
const ROOT = join(import.meta.dirname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const PROMOTION = read('tests/contract/fixtures/sales-instruction-changes/shipping-promotion.txt');
const GSEM = read('scripts/experiments/j4r7-gsem/run.mjs');
const CONVERSATION = GSEM.match(/const V9_BLOCK = `([\s\S]*?)`;/)![1]!;
const REPLACED_SENTENCE = GSEM.match(/const V8_SENTENCE = '([^']+)'/)![1]!;
const V8 = loadSalesAgentDefinition(8).instructions;

const withPromotion = (text: string) => {
  const lines = text.split('\n');
  lines.splice(lines.findIndex((l) => l.startsWith('- shipping.quote:')) + 1, 0, PROMOTION);
  return lines.join('\n');
};
const withConversation = (text: string) => text.split(REPLACED_SENTENCE).join(CONVERSATION);

const PINNED = {
  promotion: 'e9ba6726093938f096eecea3cabc8f18ec62264c355cc74cc84656c66d785484',
  conversation: 'f2c9054079475cc90e6cdcb60d1c35435ebdd48cd8a3e9fa9af98561e6717fef',
  v8Instructions: '1057c3a100f86347565e68ee8b6b4871600919709c80ad3e83d037a93fc61428',
  v8PlusPromotion: 'f0329dd55a858ae46378da89fcdbfeba2b8feed586b81a987ad82634ad0efe36', // the text J5 evaluated
  v8PlusConversation: '552edca82ff6e430c5cbf9f2e890cfca80c525c8cb432541bcb724a6e0522e9f', // the text of G-sem arm B
  v8PlusBoth: 'c1704f033548a64fd7cea8ee04946928cea8232cf8fc959489317e581c5acddc', // never evaluated
  definitions: {
    3: '44b5b0935c0c20d0304cc7c41a873e8b31252bce8a3c3df3bce8b64247db462a',
    4: 'c91f0e9da593a30cec1c0294f368cb3f922f2c8a261403e57acf47371aa3f020',
    5: '003402e257966e748f25737d59537c69da7729b41a0aef57b9cc603572fc2473',
    6: '2499d50f9297a44f1e3850ba60e4ef8f8a205f95261c8dcdee5dae43312eeff6',
    7: '1d593691a0308e47de55f3b35763be856a318e2b015600805f94141ae5c465e1',
    8: '1065b99836be5f66db05078e72b654531b30e8ae74400dcd7522e648d488e861',
    12: '11ab557711ce659fdb73a3bc50a2c1c1d6224d7822f95145a218506b3a12cfa7', // R4-J5 F1 canary definition (development branch; final text before any registration)
  },
} as const;

/** The proposed sequence. `conversationSince` stays null until D2's conditions are met and the composition is decided. */
const SEQUENCE: Sequence = { retired: [9], promotionSince: 10, conversationSince: null };
interface Sequence { readonly retired: readonly number[]; readonly promotionSince: number; readonly conversationSince: number | null }
interface Definition { readonly version: number; readonly instructions: string }

/** What a set of definitions breaks in the sequence: a version that reuses a retired number or loses a change. */
function sequenceViolations(definitions: readonly Definition[], sequence: Sequence): string[] {
  return definitions.flatMap(({ version, instructions }) => {
    const hasPromotion = instructions.includes(PROMOTION);
    const hasConversation = instructions.includes(CONVERSATION);
    const { retired, promotionSince, conversationSince } = sequence;
    return [
      ...(retired.includes(version) ? [`v${version} is retired`] : []),
      ...(version >= promotionSince && !hasPromotion ? [`v${version} lost the promotion`] : []),
      ...(version < promotionSince && hasPromotion ? [`v${version} predates the promotion`] : []),
      ...(conversationSince !== null && version >= conversationSince && !hasConversation ? [`v${version} lost the conversation block`] : []),
      ...((conversationSince === null || version < conversationSince) && hasConversation ? [`v${version} adopts the conversation block before it is authorized`] : []),
    ];
  });
}

describe('A. both changes are preserved byte-exact', () => {
  it('the promotion clause and the conversation block match their pins', () => {
    expect(sha(PROMOTION)).toBe(PINNED.promotion);
    expect(sha(CONVERSATION)).toBe(PINNED.conversation);
    expect(PROMOTION.split('\n')).toHaveLength(1);
    expect(PROMOTION.startsWith('- Despacho Directo promotion:')).toBe(true);
  });

  it('applied to v8 alone, each reproduces the text that was evaluated', () => {
    expect(sha(V8)).toBe(PINNED.v8Instructions);
    expect(sha(withPromotion(V8))).toBe(PINNED.v8PlusPromotion);
    expect(sha(withConversation(V8))).toBe(PINNED.v8PlusConversation);
  });

  it('they are independent: each anchor is unique, neither touches the other, and the order does not matter', () => {
    expect(V8.split(REPLACED_SENTENCE)).toHaveLength(2);
    expect(V8.split('\n').filter((l) => l.startsWith('- shipping.quote:'))).toHaveLength(1);
    const both = withConversation(withPromotion(V8));
    expect(both).toBe(withPromotion(withConversation(V8)));
    expect(sha(both)).toBe(PINNED.v8PlusBoth);
    expect(both.includes(PROMOTION) && both.includes(CONVERSATION)).toBe(true);
    expect(both.replace(`${PROMOTION}\n`, '').replace(CONVERSATION, REPLACED_SENTENCE)).toBe(V8);
  });
});

describe('B. the owner decisions hold in the clause and in the code', () => {
  it('the clause states the confirmed range, no net basis or commune restriction, and defers to Shipping', () => {
    expect(PROMOTION.match(/CLP [\d.]+/g)).toEqual(['CLP 120.000', 'CLP 499.990']);
    for (const assumed of [/\bnet amount\b/, /selected communes/, /Región Metropolitana/, /commune list/]) expect(PROMOTION).not.toMatch(assumed);
    expect(PROMOTION).toMatch(/The Shipping owner alone decides whether an order qualifies/);
    expect(PROMOTION).toMatch(/Never recalculate, change or discount a shipping amount/);
  });

  it('no R4 code names the promotion, and no Shipping or Quote path holds its thresholds', () => {
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name === 'dist' ? [] : e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    const rel = (file: string) => relative(ROOT, file).replace(/\\/g, '/');
    const all = ['packages', 'adapters', 'agents', 'apps'].flatMap((d) => sources(join(ROOT, d)));
    expect(all.filter((file) => /despacho directo/i.test(readFileSync(file, 'utf8'))).map(rel)).toEqual([]);
    // 120_000 elsewhere is a millisecond timeout.
    const pricing = all.filter((file) => /adapters\/domains\/(src\/)?(shipping|quote)|agents\/sales\/src\/(capabilities|workspace)\//.test(rel(file)));
    expect(pricing.length).toBeGreaterThan(20);
    expect(pricing.filter((file) => /\b120[._]?000\b|\b499[._]?990\b/.test(readFileSync(file, 'utf8'))).map(rel)).toEqual([]);
  });
});

describe('D. v12 is the recorded exception to cumulative versioning (owner, R4-J5 F1, 2026-11-05)', () => {
  it('v12 derives functionally from v7, not from v8: no Customer, no conversation block; it keeps the promotion from v10 on', () => {
    const v12 = loadSalesAgentDefinition(12).instructions;
    const v7Lines = loadSalesAgentDefinition(7).instructions.split('\n');
    expect(v12).toContain(PROMOTION);
    expect(v12).not.toContain(CONVERSATION);
    expect(v12).not.toMatch(/customer\.get_context/);
    // Every v8-only line (Customer and identity guidance) is absent: the exception is real, not a partial merge.
    const v8Only = V8.split('\n').filter((l) => !v7Lines.includes(l) && l.trim() !== '');
    expect(v8Only.length).toBeGreaterThan(0);
    expect(v8Only.filter((l) => v12.split('\n').includes(l))).toEqual([]);
  });
});

describe('C. no version identifier carries divergent content', () => {
  const versions = Object.keys(SALES_AGENT_DEFINITION_FILES).map(Number) as SalesAgentDefinitionVersion[];
  const registered = versions.map((v) => ({ version: v, instructions: loadSalesAgentDefinition(v).instructions }));

  it('v3–v8 (and v12) keep their pinned content', () => {
    const pinned = Object.keys(PINNED.definitions).map(Number) as (keyof typeof PINNED.definitions)[];
    expect(Object.fromEntries(pinned.map((v) => [v, definitionContentHash(loadSalesAgentDefinition(v))]))).toEqual(PINNED.definitions);
  });

  it('every definition file in the pack is declared: the bootstrap registers, and freezes, whatever is in the directory', () => {
    const files = readdirSync(join(ROOT, 'agents/sales')).filter((f) => f.endsWith('.agent.json')).sort();
    expect(files).toEqual(Object.values(SALES_AGENT_DEFINITION_FILES).slice().sort());
  });

  it('the retired identifiers are not in use', () => {
    expect(versions).not.toContain(9);
    expect(Object.keys(SALES_PRODUCTION_AGENT_VERSIONS)).not.toContain('sales-production@9');
  });

  it('the registered definitions satisfy the sequence', () => {
    expect(sequenceViolations(registered, SEQUENCE)).toEqual([]);
  });

  it('the sequence check fails on what it must refuse', () => {
    const promoted = withPromotion(V8);
    const composed = withConversation(promoted);
    const decided: Sequence = { ...SEQUENCE, conversationSince: 11 };
    expect(sequenceViolations([{ version: 9, instructions: promoted }], SEQUENCE)).toContain('v9 is retired');
    expect(sequenceViolations([{ version: 10, instructions: V8 }], SEQUENCE)).toEqual(['v10 lost the promotion']);
    expect(sequenceViolations([{ version: 8, instructions: promoted }], SEQUENCE)).toEqual(['v8 predates the promotion']);
    expect(sequenceViolations([{ version: 10, instructions: composed }], SEQUENCE)).toEqual(['v10 adopts the conversation block before it is authorized']);
    expect(sequenceViolations([{ version: 11, instructions: promoted }], decided)).toEqual(['v11 lost the conversation block']);
    expect(sequenceViolations([{ version: 12, instructions: withConversation(V8) }], decided)).toEqual(['v12 lost the promotion']);
    expect(sequenceViolations([{ version: 10, instructions: promoted }, { version: 11, instructions: composed }], decided)).toEqual([]);
  });
});
