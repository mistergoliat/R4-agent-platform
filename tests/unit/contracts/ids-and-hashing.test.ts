import { describe, expect, it } from 'vitest';
import { canonicalJson, fingerprint, uuidSchema, uuidv7 } from '@r4/contracts';

describe('uuidv7', () => {
  it('produces valid RFC 9562 version-7 UUIDs', () => {
    const id = uuidv7();
    expect(uuidSchema.safeParse(id).success).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is time-ordered across milliseconds', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a < b).toBe(true);
  });

  it('is unique within the same millisecond', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(5_000)));
    expect(ids.size).toBe(1000);
  });
});

describe('canonical hashing', () => {
  it('is independent of key order and ignores undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } })).toBe('{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
    expect(fingerprint({ a: 1, b: undefined })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});
