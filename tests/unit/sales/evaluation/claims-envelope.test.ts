import { describe, expect, it } from 'vitest';
import type { Observation } from '@r4/contracts';
import { SalesClaimVerifier } from '@r4-sales/agent/evaluations';

/**
 * Regression (found by the R4-H live shadow smoke, H04): a durable
 * `quote.create` observation carries the receipt envelope that ActionRuntime
 * writes — {receiptId, status, resourceRef, externalOperationRef, result,
 * executedAt} — and the quote itself is `result`. The verifier read the
 * amounts from the top level, so on real trajectories a total or shipping
 * amount stated from a receipt-backed quote was never grounded.
 */
const quote = { quoteId: 'shadow-qt-000001', quoteNumber: 'COT-900001', status: 'issued', lines: [{ productId: 'BAR-OLY20', name: 'Barra olímpica 20 kg (2,2 m)', quantity: 1, unitPrice: { amount: 129_990, currency: 'CLP' }, lineTotal: { amount: 129_990, currency: 'CLP' } }], shipping: { serviceLevel: 'standard', commune: 'Ñuñoa', amount: { amount: 20_490, currency: 'CLP' } }, subtotal: { amount: 129_990, currency: 'CLP' }, total: { amount: 150_480, currency: 'CLP' }, issuedAt: '2026-09-24T16:00:00.000Z', validUntil: '2026-10-01T16:00:00.000Z', documentRef: 'shadow-record:COT-900001', basedOnWorkspaceVersion: 2 };
const observation = (payload: unknown): Observation =>
  ({
    observationId: '0190a0a0-0000-7000-8000-00000000abcd',
    taskId: '0190a0a0-0000-7000-8000-0000000000aa',
    runId: '0190a0a0-0000-7000-8000-0000000000bb',
    agentId: 'sales',
    source: { kind: 'action', capabilityId: 'quote.create', capabilityVersion: 1, proposalId: '0190a0a0-0000-7000-8000-0000000000cc', policyDecisionId: null, executionId: null, receiptId: null },
    outcome: 'succeeded',
    payload,
    error: null,
    observedAt: '2026-09-24T16:00:00.000Z',
    validUntil: null,
    provenance: {},
    correlationId: 'c',
  }) as unknown as Observation;

const priceClaim = (amount: number) => ({ responseId: 'r', type: 'price' as const, text: `total ${amount}`, entities: [], attributes: { amount } });

describe('SalesClaimVerifier — receipt envelope of action observations', () => {
  it('grounds quote figures from the durable envelope shape (as ActionRuntime writes it)', () => {
    const envelope = observation({ receiptId: '0190a0a0-0000-7000-8000-0000000000dd', status: 'succeeded', resourceRef: 'quote:shadow-qt-000001', externalOperationRef: 'COT-900001', result: quote, executedAt: quote.issuedAt });
    const verifier = new SalesClaimVerifier();
    expect(verifier.verify(priceClaim(150_480), [envelope]).supported).toBe(true);
    expect(verifier.verify(priceClaim(20_490), [envelope]).supported).toBe(true);
    expect(verifier.verify(priceClaim(999_999), [envelope]).supported).toBe(false);
  });

  it('still accepts the bare quote payload (R4-G fixtures), unchanged', () => {
    expect(new SalesClaimVerifier().verify(priceClaim(150_480), [observation(quote)]).supported).toBe(true);
  });
});
