export {
  CANDIDATE_MAX_DIGITS,
  CANDIDATE_MIN_DIGITS,
  CODE_CONTEXT,
  CODE_DIGITS,
  inspectVerificationText,
  type ReplacementReason,
  type VerificationInspectionContext,
  type VerificationTextInspection,
} from './classifier.js';
export { FORGEABLE_MARKER_PREFIXES, PLATFORM_MARKERS } from './markers.js';
export { confirmIdempotencyKey, conversationLockKey } from './keys.js';
export { Keyring, SecretBox, SecretBoxError, sealedCodeAad, type SealedCode, type SealedCodeBinding, type SecretBoxErrorCode } from './secret-box.js';
export {
  DEFAULT_PROTECTION_GRACE_MS,
  DEFAULT_RETENTION_MS,
  DEFAULT_UNISSUED_TTL_MS,
  IdentityVerificationError,
  IdentityVerificationStore,
  lockConversation,
  type CapturedResponse,
  type CiaConfirmOutcome,
  type ClaimSettlement,
  type ExpectationRecord,
  type ExpectationState,
  type IdentityVerificationErrorCode,
  type IdentityVerificationStoreOptions,
  type NewExpectation,
  type ResponseClaim,
  type ResponseRecord,
  type ResponseState,
} from './state-store.js';
export { IDENTITY_VERIFICATION_MIGRATIONS_DIR, identityVerificationSchemaIsCurrent, migrateIdentityVerification } from './migrate.js';
