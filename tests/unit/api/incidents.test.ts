import { describe, expect, it } from 'vitest';
import { INCIDENT_SIGNATURE, compareIncidents, incidentSeverity, incidentSignature, triageView, type Incident } from '@r4/persistence-postgres';

/** ADR-051 pure helpers: severity mapping (Decision 1), signature format, reopen rule and ordering (Decision 2). */
describe('ADR-051 incident helpers', () => {
  it.each([
    ['customer_unanswered', 'no_accepted_reply', 'critical'],
    ['run_failed', 'model_failure/provider_error', 'high'],
    ['run_failed', 'budget_exhausted/max_write_actions', 'high'],
    ['run_failed', 'invalid_decision/invalid_structured_output', 'medium'],
    ['run_failed', 'invalid_decision/unknown_evidence', 'medium'],
    ['platform_handoff', 'non_retryable_model_failure', 'medium'],
    ['platform_handoff', 'unsupported_inbound_content', 'medium'],
    ['platform_handoff', 'autonomy_disabled', 'info'],
    ['platform_handoff', 'rollout_excluded', 'info'],
    ['step_error', 'invalid_structured_output', 'low'],
    ['outbound_problem', 'unknown', 'critical'],
    ['outbound_problem', 'failed/131047', 'high'],
    ['outbound_problem', 'cancelled/expired', 'high'],
    ['outbound_problem', 'cancelled/window_closed', 'high'],
    ['inbound_problem', 'failed/incomplete_inbound_record', 'high'],
    ['inbound_problem', 'foreign_business_number', 'info'],
    ['slow_reply', 'customer_turn_over_60s', 'medium'],
    ['consultation_waiting', 'unanswered_over_10_min', 'high'],
  ] as const)('%s %s → %s', (detector, code, severity) => {
    expect(incidentSeverity(detector, code)).toBe(severity);
  });

  it('signatures: built from detector, agent, version and code; the format accepts exactly those', () => {
    const s = incidentSignature('run_failed', 'sales-agent', 22, 'model_failure/provider_error');
    expect(s).toBe('run_failed:sales-agent@22:model_failure/provider_error');
    expect(incidentSignature('inbound_problem', null, null, 'foreign_business_number')).toBe('inbound_problem:-@-:foreign_business_number');
    for (const ok of [s, 'inbound_problem:-@-:foreign_business_number', 'slow_reply:sales@1:customer_turn_over_60s']) expect(INCIDENT_SIGNATURE.test(ok), ok).toBe(true);
    for (const bad of ['', 'other:sales@1:x', 'run_failed:sales@1:', 'run_failed:Sales@1:x', 'run_failed:sales@v1:x', 'run_failed:sales@1:a b', 'run_failed:sales:x', `run_failed:sales@1:${'x'.repeat(201)}`]) {
      expect(INCIDENT_SIGNATURE.test(bad), bad).toBe(false);
    }
  });

  it('triage: open without a decision; reopened only when the last occurrence is after the decision', () => {
    expect(triageView(undefined, '2026-11-19T10:00:00.000Z')).toEqual({ state: 'open', note: null, requestUrl: null, decidedBy: null, decidedAt: null });
    const stored = { state: 'ignored' as const, note: 'known', requestUrl: null, decidedBy: 'oidc:felipe', decidedAt: '2026-11-19T10:00:00.000Z' };
    expect(triageView(stored, '2026-11-19T10:00:00.000Z')).toEqual(stored);
    expect(triageView(stored, '2026-11-19T09:59:59.999Z').state).toBe('ignored');
    expect(triageView(stored, '2026-11-19T10:00:00.001Z')).toEqual({ ...stored, state: 'reopened' });
    expect(triageView({ ...stored, state: 'requested', requestUrl: 'https://github.com/x/y/issues/1' }, '2026-11-19T11:00:00.000Z').state).toBe('reopened');
  });

  it('ordering: severity first, then the most recent last occurrence', () => {
    const at = (severity: Incident['severity'], lastSeen: string) => ({ severity, lastSeen }) as Incident;
    const list = [at('info', '2026-11-19T12:00:00Z'), at('high', '2026-11-18T00:00:00Z'), at('critical', '2026-11-01T00:00:00Z'), at('high', '2026-11-19T00:00:00Z'), at('low', '2026-11-19T00:00:00Z'), at('medium', '2026-11-19T00:00:00Z')];
    expect(list.sort(compareIncidents).map((i) => `${i.severity}@${i.lastSeen.slice(0, 10)}`)).toEqual([
      'critical@2026-11-01', 'high@2026-11-19', 'high@2026-11-18', 'medium@2026-11-19', 'low@2026-11-19', 'info@2026-11-19',
    ]);
  });
});
