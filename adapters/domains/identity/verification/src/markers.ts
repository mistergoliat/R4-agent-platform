/**
 * Platform marker texts of SEC-OTP (decision rev. 02 §8.3, OA-08). Platform-authored, English,
 * bracketed, and never carrying digits of a code, an email or an identifier. The resume marker
 * carries no outcome: the model reads the state from identity.verification_status (OA-11).
 */
export const PLATFORM_MARKERS = {
  codeReceived: '[verification code received by platform]',
  numberWithheld: '[number withheld by platform: identity verification in progress; ask the customer to send only the 6-digit code]',
  messageWithheld: '[message withheld by platform: identity verification in progress]',
  quotedMarkerRemoved: '[quoted platform marker removed]',
  updateAvailable: '[identity verification update available]',
} as const;

/**
 * How a forged marker starts, after normalization (lower case, words separated by any spacing).
 * "identity verification" covers the update marker and any other identity-verification look-alike.
 */
export const FORGEABLE_MARKER_PREFIXES: readonly (readonly string[])[] = [
  ['verification', 'code', 'received', 'by', 'platform'],
  ['number', 'withheld', 'by', 'platform'],
  ['message', 'withheld', 'by', 'platform'],
  ['quoted', 'platform', 'marker', 'removed'],
  ['identity', 'verification'],
];
