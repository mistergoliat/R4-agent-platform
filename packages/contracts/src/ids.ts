import { randomBytes } from 'node:crypto';

/**
 * Ports for the two sources of non-determinism in the runtime. Services receive
 * them by injection so tests can be fully deterministic.
 */
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * RFC 9562 UUIDv7: time-ordered (good B-tree locality for durable tables) and
 * globally unique without coordination.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = randomBytes(16);
  let ts = BigInt(nowMs);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidV7Generator(clock: Clock = systemClock): IdGenerator {
  return { next: () => uuidv7(clock.now().getTime()) };
}
