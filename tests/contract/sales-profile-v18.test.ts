import { describe, expect, it } from 'vitest';
import { loadAgentDefinitionsFromDirectory } from '@r4/agent-registry';
import { createSilentLogger } from '@r4/observability';
import { loadProductionConfig, profileFingerprint, profileLabel, type ProductionStore } from '@r4/live-ops';
import { FixtureCatalog, FixtureQuoteV2Service, FixtureShipping, type CatalogPort, type QuoteV2Service, type ShippingService } from '@r4-adapters/domains';
import type { CatalogDiscoverPort } from '@r4-adapters/catalog-http';
import { SALES_AGENT_DIR, chileDateTime, loadSalesAgentDefinition, quoteDocumentCaption, quoteDocumentDelivery, quoteDocumentFilename, quoteDocumentNoticeKey } from '@r4-sales/agent';
import { CANARY_PROFILES } from '@r4-sales/agent/canary';
import {
  SALES_CANARY_ONLY_PROFILES,
  SALES_F1_CANARY_LIMITS,
  SALES_HUMAN_REQUEST_NOTICE_PROFILES,
  SALES_LANE_PROFILES,
  SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY,
  SALES_PRODUCTION_PROFILES,
  SALES_PRODUCTION_PROFILE_V17,
  SALES_PRODUCTION_PROFILE_V18,
  SALES_PRODUCTION_PROFILE_V18_GATE,
  SALES_QUOTE_DOCUMENT_PROFILES,
  SALES_VARIANT_AVAILABILITY_PROFILES,
  composeSalesProductionWorker,
  isQuoteLaneProfile,
  salesCatalogSourceOf,
  salesCommercialEligibility,
  salesProductionActionPolicy,
  salesProductionAgentVersion,
  selectedSalesProductionProfile,
} from '@r4-sales/agent/production';

/**
 * (Quote PDF delivery) sales-production@18 is exactly @17 (domains, capabilities, policy, F1 commercial policy, F-ADV-2
 * notice) except that an issued quote's own PDF follows it to the conversation, with definition v17 = v16 except the
 * document sentence of the quote.create rule. @17 is unchanged.
 */
const noStore = { readControls: () => Promise.reject(new Error('unused')), thread: () => Promise.reject(new Error('unused')) } as unknown as ProductionStore;
const env = (profile: string) => loadProductionConfig({ R4_EXECUTION_MODE: 'production', R4_PROD_POLICY_PROFILE: profile, R4_PROD_ROLLOUT_PERCENT: '0', R4_PROD_IDENTITY_HASH_KEY: 'x'.repeat(40), R4_PROD_ALLOW_NETWORK: 'false' });
const http = <T extends object>(port: T) => Object.assign(Object.create(port) as T, { bindingKind: 'http' });
const discover: CatalogDiscoverPort = { discoverConfigured: true, discover: () => Promise.reject(new Error('unused')) };
const ids = (profile: string) =>
  composeSalesProductionWorker({
    pool: { query: () => Promise.reject(new Error('no db')) } as never,
    store: noStore,
    production: env(profile),
    modelProvider: { providerId: 'none', invoke: () => Promise.reject(new Error('unused')) },
    logger: createSilentLogger(),
    catalog: http(new FixtureCatalog() as CatalogPort),
    catalogDiscover: discover,
    shipping: http(new FixtureShipping() as ShippingService),
    quotes: http(new FixtureQuoteV2Service() as QuoteV2Service),
    autonomousQuoteLimits: SALES_F1_CANARY_LIMITS,
  }).bindings.capabilities.list().map((c) => `${c.capabilityId}@${c.version}`).sort();

describe('@18 is @17 plus the issued quote\'s PDF, a lane (and isolated canary) profile only', () => {
  const v18 = SALES_PRODUCTION_PROFILE_V18;
  it('same domains, channel and capabilities as @17; its own version and fingerprint; definition v17; same F1 policies', () => {
    expect(v18.version).toBe(18);
    expect(v18.domains).toEqual(SALES_PRODUCTION_PROFILE_V17.domains);
    expect(v18.channel).toEqual(SALES_PRODUCTION_PROFILE_V17.channel);
    expect(v18.capabilities).toEqual(SALES_PRODUCTION_PROFILE_V17.capabilities);
    expect(profileFingerprint(v18)).not.toBe(profileFingerprint(SALES_PRODUCTION_PROFILE_V17));
    expect(salesProductionAgentVersion(v18)).toBe(17);
    expect(ids('sales-production@18')).toEqual(ids('sales-production@17'));
    expect(SALES_VARIANT_AVAILABILITY_PROFILES.has('sales-production@18')).toBe(true);
    expect(salesCommercialEligibility(v18)).toEqual(salesCommercialEligibility(SALES_PRODUCTION_PROFILE_V17));
    expect(SALES_HUMAN_REQUEST_NOTICE_PROFILES).toContain('sales-production@18');
    expect([...SALES_QUOTE_DOCUMENT_PROFILES]).toEqual(['sales-production@18', 'sales-production@19']);
  });

  it('lane and canary only; autonomous policy; Catalog V2; quote-lane ceilings; every gate item blocking', () => {
    expect(SALES_LANE_PROFILES.map(profileLabel)).toContain('sales-production@18');
    expect(CANARY_PROFILES.map(profileLabel)).toContain('sales-production@18');
    expect([...SALES_PRODUCTION_PROFILES, ...SALES_CANARY_ONLY_PROFILES].map(profileLabel)).not.toContain('sales-production@18');
    expect(() => selectedSalesProductionProfile(env('sales-production@18').config)).toThrow(/not a Sales production profile/);
    expect(selectedSalesProductionProfile(env('sales-production@18').config, { lane: true })).toBe(v18);
    expect(salesProductionActionPolicy(v18)).toBe(SALES_PRODUCTION_AUTONOMOUS_ACTION_POLICY);
    expect(salesCatalogSourceOf(v18)).toBe('v2');
    expect(isQuoteLaneProfile(v18)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V18_GATE.every((g) => g.blocking)).toBe(true);
    expect(SALES_PRODUCTION_PROFILE_V18_GATE.map((g) => g.id)).toEqual(expect.arrayContaining(['core-0015', 'document-delivery-l3', 'profile-18-registered', 'explicit-authorization']));
  });
});

describe('the document notice: one per quote, plain names, never throws', () => {
  const doc = { taskId: 't-1', quoteId: 'AB-12', quoteNumber: 'PC-000017', validUntilExclusive: '2026-11-10T03:17:31.000Z', sha256: 'f'.repeat(64), bytes: new Uint8Array([1]), correlationId: 'c' };
  it('derives its key from the quote id only, and a plain file name and caption from the quote number', async () => {
    const calls: { noticeKey: string; text: string; document: { filename: string; sha256: string } }[] = [];
    const delivery = quoteDocumentDelivery({ createPlatformNotice: (c) => (calls.push(c), Promise.resolve({ replayed: calls.length > 1 })) }, createSilentLogger());
    await delivery.queue(doc);
    await delivery.queue(doc);
    expect(calls.map((c) => c.noticeKey)).toEqual([quoteDocumentNoticeKey('AB-12'), quoteDocumentNoticeKey('AB-12')]);
    expect(quoteDocumentNoticeKey('AB-12')).toMatch(/^[a-z][a-z0-9._:-]{2,199}$/);
    expect(calls[0]).toMatchObject({ text: 'Cotización N° PC-000017 (PDF). Válida hasta el 10-11-2026 a las 00:17 (hora de Chile).', document: { filename: 'Cotizacion-PC-000017.pdf', sha256: 'f'.repeat(64) } });
    expect(quoteDocumentFilename('PC 0/17')).toBe('Cotizacion-PC-0-17.pdf');
    // Chile changes its offset with daylight saving: summer (UTC-3) and winter (UTC-4).
    expect(chileDateTime('2026-11-10T03:17:31.000Z')).toEqual({ date: '10-11-2026', time: '00:17' });
    expect(chileDateTime('2026-07-01T15:05:00.000Z')).toEqual({ date: '01-07-2026', time: '11:05' });
    expect(quoteDocumentCaption('PC-1', '2026-07-01T15:05:00.000Z')).toBe('Cotización N° PC-1 (PDF). Válida hasta el 01-07-2026 a las 11:05 (hora de Chile).');
  });

  it('a store failure is reported, never thrown (the quote stays issued)', async () => {
    const warned: unknown[] = [];
    const logger = { ...createSilentLogger(), warn: (fields: unknown) => void warned.push(fields) } as ReturnType<typeof createSilentLogger>;
    const delivery = quoteDocumentDelivery({ createPlatformNotice: () => Promise.reject(Object.assign(new Error('x'), { code: 'task_not_channel_bound' })) }, logger);
    await expect(delivery.queue(doc)).resolves.toBeUndefined();
    expect(warned).toEqual([expect.objectContaining({ event: 'quote.document.not_queued', errorCode: 'task_not_channel_bound', quoteId: 'AB-12' })]);
    expect(JSON.stringify(warned)).not.toMatch(/Cotizacion|PC-000017/);
  });
});

describe('definition v17 = v16 except the document sentence of the quote.create rule', () => {
  const v16 = loadSalesAgentDefinition(16);
  const v17 = loadSalesAgentDefinition(17);
  it('changes one line: the platform sends the PDF; the agent never sends it, links it or asks for an email', () => {
    const changed = v17.instructions.split('\n').filter((l) => !v16.instructions.split('\n').includes(l));
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatch(/^- quote\.create: .*Right after issuance the platform itself sends the issued quote's PDF to this conversation; you never send it, write a link to it or ask for an email.*You cannot send the quote by email\.$/);
    expect(v17.instructions).not.toMatch(/share its document/);
    expect(v17.instructions.replace(changed[0]!, '')).toBe(v16.instructions.replace(v16.instructions.split('\n').find((l) => l.startsWith('- quote.create: '))!, ''));
    const { instructions: _a, version: _b, description: _c, ...rest17 } = v17;
    const { instructions: _d, version: _e, description: _f, ...rest16 } = v16;
    expect(rest17).toEqual(rest16);
  });

  it('is a candidate file: the plain bootstrap never registers it', async () => {
    const loaded = await loadAgentDefinitionsFromDirectory(SALES_AGENT_DIR);
    expect(loaded.map((e) => `${e.definition.agentId}@${e.definition.version}`)).not.toContain('sales@17');
  });
});
