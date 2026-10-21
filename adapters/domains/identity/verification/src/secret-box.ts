import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * SEC-S2 — authenticated encryption of a captured verification code (decision rev. 02 §7.2b).
 * AES-256-GCM, a fresh random 96-bit IV per record, a 128-bit tag, and AAD bound to the identity of
 * the response, so a sealed code cannot be moved to another row, expectation or provider event.
 * Keys come from the composition (never from this package's environment) and are never persisted:
 * only their identifier is. Only the process holding the keyring can open a code (the gateway in S3);
 * the agent, the harness and the stores never hold it.
 */

const KEY_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const CODE = /^[0-9]{6}$/;
const AAD_DOMAIN = 'r4.identity-verification.code.v1';

/** Key material is reachable only from this module (no accessor on Keyring). */
const MATERIAL = new WeakMap<Keyring, ReadonlyMap<string, Buffer>>();
const materialOf = (keyring: Keyring, id: string): Buffer | undefined => MATERIAL.get(keyring)?.get(id);

export type SecretBoxErrorCode = 'invalid_keyring' | 'invalid_code' | 'unknown_key' | 'decrypt_failed';

/** Carries only a code: never key material, plaintext, ciphertext or AAD. */
export class SecretBoxError extends Error {
  readonly code: SecretBoxErrorCode;

  constructor(code: SecretBoxErrorCode) {
    super(`secret box: ${code}`);
    this.name = 'SecretBoxError';
    this.code = code;
  }
}

/**
 * Ordered keys: the first seals, every one opens (rotation keeps the previous key until every code
 * sealed with it has expired, ≤ 20 min). Opaque when printed or serialized.
 */
export class Keyring {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #current: string;

  private constructor(keys: ReadonlyMap<string, Buffer>, current: string) {
    this.#keys = keys;
    this.#current = current;
    MATERIAL.set(this, keys);
  }

  /** `id:base64(32 bytes)[,id:base64(32 bytes)…]` — the format of R4_PROD_VERIFICATION_CODE_KEYS. */
  static parse(spec: string): Keyring {
    const keys = new Map<string, Buffer>();
    for (const entry of spec.split(',').map((e) => e.trim()).filter((e) => e.length > 0)) {
      const separator = entry.indexOf(':');
      const id = entry.slice(0, separator);
      const material = Buffer.from(entry.slice(separator + 1), 'base64');
      if (separator < 1 || !KEY_ID.test(id) || keys.has(id) || material.length !== 32) throw new SecretBoxError('invalid_keyring');
      keys.set(id, material);
    }
    const [current] = keys.keys();
    if (current === undefined) throw new SecretBoxError('invalid_keyring');
    return new Keyring(keys, current);
  }

  get currentKeyId(): string {
    return this.#current;
  }

  get keyIds(): readonly string[] {
    return [...this.#keys.keys()];
  }

  toJSON(): { keyIds: readonly string[] } {
    return { keyIds: this.keyIds };
  }

  toString(): string {
    return `Keyring(${this.keyIds.join(',')})`;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return this.toString();
  }
}

export interface SealedCode {
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly keyId: string;
}

/** The identity a sealed code is bound to (its AAD). */
export interface SealedCodeBinding {
  readonly responseId: string;
  readonly expectationId: string;
  readonly channel: string;
  readonly providerEventId: string;
}

export function sealedCodeAad(binding: SealedCodeBinding): Buffer {
  return Buffer.from(JSON.stringify([AAD_DOMAIN, binding.responseId, binding.expectationId, binding.channel, binding.providerEventId]), 'utf8');
}

export class SecretBox {
  readonly #keyring: Keyring;

  constructor(keyring: Keyring) {
    this.#keyring = keyring;
  }

  seal(code: string, binding: SealedCodeBinding): SealedCode {
    if (!CODE.test(code)) throw new SecretBoxError('invalid_code');
    const keyId = this.#keyring.currentKeyId;
    const key = materialOf(this.#keyring, keyId);
    if (!key) throw new SecretBoxError('unknown_key');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(sealedCodeAad(binding));
    const ciphertext = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    return { ciphertext, iv, tag: cipher.getAuthTag(), keyId };
  }

  open(sealed: SealedCode, binding: SealedCodeBinding): string {
    const key = materialOf(this.#keyring, sealed.keyId);
    if (!key) throw new SecretBoxError('unknown_key');
    let code: string;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv, { authTagLength: 16 });
      decipher.setAAD(sealedCodeAad(binding));
      decipher.setAuthTag(sealed.tag);
      code = Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretBoxError('decrypt_failed');
    }
    if (!CODE.test(code)) throw new SecretBoxError('decrypt_failed');
    return code;
  }

  toJSON(): { keyring: { keyIds: readonly string[] } } {
    return { keyring: this.#keyring.toJSON() };
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `SecretBox(${this.#keyring.toString()})`;
  }
}
