import { z } from 'zod';
import type { CustomerDirectory } from '@r4-adapters/domains';
import type { CapabilityRegistration } from '@r4/capability-runtime';
import { CAPABILITY_IDS, SCOPES } from '../ids.js';
import type { PostgresSalesStore } from '../workspace/store.js';
import { domainRead, readDefinition } from './common.js';

export const customerContextInput = z.strictObject({});
export const customerContextOutput = z.union([
  z.strictObject({ identity: z.literal('unavailable'), reason: z.enum(['anonymous', 'not_on_file']) }),
  z.strictObject({
    identity: z.literal('provisional'),
    customer: z.strictObject({
      displayName: z.string(),
      contact: z.strictObject({ email: z.string().nullable(), phone: z.string().nullable() }),
      preferredCommune: z.string().nullable(),
      previousPurchases: z.array(z.strictObject({ productId: z.string(), purchasedAt: z.string() })),
    }),
  }),
]);

/**
 * Who the customer is comes from the conversation binding the Sales ingress
 * recorded for this task (trusted), never from model arguments: the
 * capability takes no customer reference at all. An anonymous conversation
 * is an answer (`identity: unavailable`), so exploring products never
 * depends on identity.
 */
export function customerCapability(directory: CustomerDirectory, conversations: Pick<PostgresSalesStore, 'conversation'>): CapabilityRegistration<z.infer<typeof customerContextInput>, z.infer<typeof customerContextOutput>> {
  return {
    definition: readDefinition({
      capabilityId: CAPABILITY_IDS.customerContext,
      description: 'Reads what the Customer owner has on file for the customer of this conversation (name, contact on file, preferred commune, previous purchases). Takes no arguments: the customer is the one the conversation is bound to. Answers identity=unavailable when the customer is anonymous or not on file.',
      owner: 'customer',
      requiredScopes: [SCOPES.customerRead],
      freshnessTtlMs: 60 * 60_000,
    }),
    input: customerContextInput,
    output: customerContextOutput,
    handler: (_input, context) => domainRead(async () => {
      const binding = await conversations.conversation(context.execution.taskId);
      if (!binding?.customerRef) return { identity: 'unavailable' as const, reason: 'anonymous' as const };
      const profile = await directory.getContext(binding.customerRef, { signal: context.signal });
      if (!profile) return { identity: 'unavailable' as const, reason: 'not_on_file' as const };
      return {
        identity: 'provisional' as const,
        customer: { displayName: profile.displayName, contact: { ...profile.contact }, preferredCommune: profile.preferredCommune, previousPurchases: profile.previousPurchases.map((p) => ({ ...p })) },
      };
    }),
  };
}
