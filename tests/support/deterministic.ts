import type { Clock, IdGenerator } from '@r4/contracts';
import { uuidv7 } from '@r4/contracts';

/** Manually advanced clock for deterministic timestamps. */
export class FakeClock implements Clock {
  #now: number;

  constructor(start = '2026-01-01T00:00:00.000Z') {
    this.#now = Date.parse(start);
  }

  now(): Date {
    return new Date(this.#now);
  }

  advance(ms: number): void {
    this.#now += ms;
  }
}

/** UUIDv7 ids derived from the fake clock (unique, valid, clock-ordered). */
export function idsFrom(clock: Clock): IdGenerator {
  return { next: () => uuidv7(clock.now().getTime()) };
}
