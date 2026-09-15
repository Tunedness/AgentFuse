import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  assertSameEra,
  declaredProtocolVersion,
  detectRequestEra,
  EraMismatchError,
  eraOfConnection,
  eraOfProtocolVersion,
  FIRST_MODERN_PROTOCOL_VERSION,
} from './era.js';

describe('eraOfProtocolVersion', () => {
  it.each([
    ['2024-10-07', 'legacy'],
    ['2024-11-05', 'legacy'],
    ['2025-03-26', 'legacy'],
    ['2025-06-18', 'legacy'],
    ['2025-11-25', 'legacy'],
    ['2026-07-28', 'modern'],
  ] as const)('classifies %s as %s', (version, era) => {
    expect(eraOfProtocolVersion(version)).toBe(era);
  });

  it('sorts an unknown future revision into the modern era', () => {
    // Revisions are ISO dates, so a lexicographic compare is chronological.
    // An unrecognised 2027 revision is a *later* revision, not a legacy one.
    expect(eraOfProtocolVersion('2027-01-01')).toBe('modern');
  });

  it('puts the boundary revision itself on the modern side', () => {
    expect(eraOfProtocolVersion(FIRST_MODERN_PROTOCOL_VERSION)).toBe('modern');
  });
});

describe('declaredProtocolVersion', () => {
  it('reads the version out of the lifted envelope', () => {
    const signals = { envelope: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' } };

    expect(declaredProtocolVersion(signals)).toBe('2026-07-28');
  });

  it('reads the version out of raw _meta when the envelope was not lifted', () => {
    const signals = { meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' } };

    expect(declaredProtocolVersion(signals)).toBe('2026-07-28');
  });

  it('prefers the envelope over raw _meta', () => {
    const signals = {
      meta: { [PROTOCOL_VERSION_META_KEY]: '2025-11-25' },
      envelope: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' },
    };

    expect(declaredProtocolVersion(signals)).toBe('2026-07-28');
  });

  it('ignores a non-string value', () => {
    expect(declaredProtocolVersion({ meta: { [PROTOCOL_VERSION_META_KEY]: 42 } })).toBeUndefined();
  });

  it('is undefined for a request with no _meta at all', () => {
    expect(declaredProtocolVersion({})).toBeUndefined();
  });
});

describe('detectRequestEra', () => {
  it('treats a declared protocol version as modern-era evidence', () => {
    expect(detectRequestEra({ envelope: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' } })).toBe(
      'modern',
    );
  });

  it('treats the absence of a declared version as legacy', () => {
    // A modern request is required to carry the key, so a request without one
    // cannot be a modern request.
    expect(detectRequestEra({ meta: { progressToken: 1 } })).toBe('legacy');
  });

  it('classifies a declared legacy revision as legacy even though it was declared', () => {
    expect(detectRequestEra({ meta: { [PROTOCOL_VERSION_META_KEY]: '2025-11-25' } })).toBe(
      'legacy',
    );
  });
});

describe('eraOfConnection', () => {
  it('prefers the connection’s own answer', () => {
    const era = eraOfConnection({
      getProtocolEra: () => 'modern',
      getNegotiatedProtocolVersion: () => '2025-11-25',
    });

    expect(era).toBe('modern');
  });

  it('falls back to classifying the negotiated version', () => {
    const era = eraOfConnection({
      getProtocolEra: () => undefined,
      getNegotiatedProtocolVersion: () => '2025-06-18',
    });

    expect(era).toBe('legacy');
  });

  it('is undefined for a connection that never negotiated', () => {
    const era = eraOfConnection({
      getProtocolEra: () => undefined,
      getNegotiatedProtocolVersion: () => undefined,
    });

    expect(era).toBeUndefined();
  });
});

describe('assertSameEra', () => {
  it('passes when both sides agree', () => {
    expect(() => {
      assertSameEra('legacy', 'legacy');
    }).not.toThrow();
  });

  it('throws an EraMismatchError naming both sides', () => {
    let thrown: unknown;
    try {
      assertSameEra('modern', 'legacy');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EraMismatchError);
    const error = thrown as EraMismatchError;
    expect(error.downstream).toBe('modern');
    expect(error.upstream).toBe('legacy');
    expect(error.name).toBe('EraMismatchError');
  });

  it('says which side is which and what to change', () => {
    // The message is the product surface for this failure: somebody hits it
    // while wiring AgentFuse in for the first time.
    const message = new EraMismatchError('modern', 'legacy').message;

    expect(message).toContain('downstream client speaks the modern era');
    expect(message).toContain('upstream server speaks the legacy era');
    expect(message).toContain('does not translate');
    expect(message).toContain('2026-07-28 revision');
  });

  it('steers the other way round for a legacy downstream', () => {
    expect(new EraMismatchError('legacy', 'modern').message).toContain(
      'upgrading the client to negotiate the 2026-07-28 revision',
    );
  });

  it('explains an upstream that never negotiated at all', () => {
    const error = new EraMismatchError('legacy', undefined);

    expect(error.message).toContain('no era at all');
    expect(error.upstream).toBeUndefined();
  });

  it('appends caller-supplied detail', () => {
    expect(new EraMismatchError('legacy', 'modern', 'upstream=filesystem').message).toContain(
      'upstream=filesystem',
    );
  });

  it('throws when the upstream never negotiated', () => {
    expect(() => {
      assertSameEra('legacy', undefined);
    }).toThrow(EraMismatchError);
  });
});
