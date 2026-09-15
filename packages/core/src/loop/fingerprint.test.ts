import { describe, expect, it } from 'vitest';
import { errorSignature, fingerprint, shortFingerprint } from './fingerprint.js';

describe('fingerprint', () => {
  it('is stable for the same inputs', () => {
    expect(fingerprint('fs', 'read', '{}')).toBe(fingerprint('fs', 'read', '{}'));
  });

  it('separates the fields, so a space in a name cannot forge a collision', () => {
    expect(fingerprint('a b', 'c', '{}')).not.toBe(fingerprint('a', 'b c', '{}'));
  });

  it('changes when any field changes', () => {
    const base = fingerprint('fs', 'read', '{"a":1}');
    expect(fingerprint('net', 'read', '{"a":1}')).not.toBe(base);
    expect(fingerprint('fs', 'write', '{"a":1}')).not.toBe(base);
    expect(fingerprint('fs', 'read', '{"a":2}')).not.toBe(base);
  });

  it('shortens to something a human can compare at a glance', () => {
    expect(shortFingerprint(fingerprint('fs', 'read', '{}'))).toHaveLength(12);
  });
});

describe('errorSignature', () => {
  it('prefers a structured code', () => {
    expect(errorSignature({ code: -32602, text: 'whatever' })).toBe('code:-32602');
    expect(errorSignature({ code: 'ENOENT' })).toBe('code:ENOENT');
  });

  it('gives two failures with different temp paths the same signature', () => {
    const a = errorSignature({ text: 'file not found: /tmp/a1b2' });
    const b = errorSignature({ text: 'file not found: /tmp/c3d4' });
    expect(a).toBe(b);
    expect(a).toContain('«path»');
  });

  it('masks bare numbers and hex runs', () => {
    expect(errorSignature({ text: 'retry 17 failed for deadbeefcafebabe' })).toBe(
      'retry «n» failed for «hex»',
    );
  });

  it('uses only the first line, because stack traces differ every time', () => {
    const a = errorSignature({ text: 'boom\n  at foo (x.ts:1:1)' });
    const b = errorSignature({ text: 'boom\n  at bar (y.ts:9:9)' });
    expect(a).toBe('boom');
    expect(b).toBe('boom');
  });

  it('falls back to a constant when there is nothing to go on', () => {
    expect(errorSignature({})).toBe('unknown_error');
    expect(errorSignature({ code: '', text: '   ' })).toBe('unknown_error');
  });
});
