import {
  BAGGAGE_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  TRACEPARENT_META_KEY,
  TRACESTATE_META_KEY,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import {
  baggageEntry,
  clientInfoOf,
  FORWARDED_META_KEYS,
  forwardedMeta,
  mergeMeta,
  RequestRemap,
  splitProgressToken,
  traceparentOf,
  upstreamParams,
} from './remap.js';

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
/** The same trace, a span the proxy minted: what a re-injection looks like. */
const OVERRIDE_TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-0123456789abcdef-01';

describe('mergeMeta', () => {
  it('is undefined when there is nothing to merge', () => {
    expect(mergeMeta(undefined, undefined)).toBeUndefined();
  });

  it('puts the lifted envelope back over _meta', () => {
    const merged = mergeMeta({ progressToken: 7 }, { [CLIENT_INFO_META_KEY]: { name: 'a' } });

    expect(merged).toEqual({ progressToken: 7, [CLIENT_INFO_META_KEY]: { name: 'a' } });
  });

  it('lets the envelope win a collision, because the SDK lifted it from there', () => {
    expect(mergeMeta({ x: 1 }, { x: 2 })).toEqual({ x: 2 });
  });
});

describe('traceparentOf', () => {
  it('reads a traceparent', () => {
    expect(traceparentOf({ [TRACEPARENT_META_KEY]: TRACEPARENT })).toBe(TRACEPARENT);
  });

  it('rejects an empty string, which is not a trace context', () => {
    expect(traceparentOf({ [TRACEPARENT_META_KEY]: '' })).toBeUndefined();
  });

  it('rejects a non-string', () => {
    expect(traceparentOf({ [TRACEPARENT_META_KEY]: 1 })).toBeUndefined();
  });

  it('is undefined for absent _meta', () => {
    expect(traceparentOf(undefined)).toBeUndefined();
  });
});

describe('baggageEntry', () => {
  it('finds a member by name', () => {
    const meta = { [BAGGAGE_META_KEY]: 'userId=alice,tunedness.session-id=01J' };

    expect(baggageEntry(meta, 'tunedness.session-id')).toBe('01J');
  });

  it('tolerates whitespace around the key', () => {
    expect(baggageEntry({ [BAGGAGE_META_KEY]: ' a = 1 , b = 2 ' }, 'b')).toBe('2');
  });

  it('strips the entry properties after a semicolon', () => {
    expect(baggageEntry({ [BAGGAGE_META_KEY]: 'a=1;meta=x' }, 'a')).toBe('1');
  });

  it('percent-decodes the value', () => {
    expect(baggageEntry({ [BAGGAGE_META_KEY]: 'a=one%20two' }, 'a')).toBe('one two');
  });

  it('keeps a value containing an equals sign', () => {
    expect(baggageEntry({ [BAGGAGE_META_KEY]: 'a=k=v' }, 'a')).toBe('k=v');
  });

  it('is undefined for a missing name', () => {
    expect(baggageEntry({ [BAGGAGE_META_KEY]: 'a=1' }, 'b')).toBeUndefined();
  });

  it('is undefined for an empty value', () => {
    expect(baggageEntry({ [BAGGAGE_META_KEY]: 'a=' }, 'a')).toBeUndefined();
  });

  it('is undefined for a bare member with no equals sign', () => {
    expect(baggageEntry({ [BAGGAGE_META_KEY]: 'a' }, 'a')).toBeUndefined();
  });

  it('does not let a malformed member cost the well-formed one next to it', () => {
    expect(baggageEntry({ [BAGGAGE_META_KEY]: 'broken,a=1' }, 'a')).toBe('1');
  });

  it('is undefined when baggage is not a string', () => {
    expect(baggageEntry({ [BAGGAGE_META_KEY]: {} }, 'a')).toBeUndefined();
  });

  it('is undefined for absent _meta', () => {
    expect(baggageEntry(undefined, 'a')).toBeUndefined();
  });
});

describe('clientInfoOf', () => {
  it('reads the declared client identity', () => {
    const meta = { [CLIENT_INFO_META_KEY]: { name: 'claude-code', version: '2.0.0' } };

    expect(clientInfoOf(meta)).toEqual({ name: 'claude-code', version: '2.0.0' });
  });

  it('rejects an identity with no name', () => {
    expect(clientInfoOf({ [CLIENT_INFO_META_KEY]: { version: '1' } })).toBeUndefined();
  });

  it('rejects a non-object', () => {
    expect(clientInfoOf({ [CLIENT_INFO_META_KEY]: 'claude' })).toBeUndefined();
  });

  it('is undefined for absent _meta', () => {
    expect(clientInfoOf(undefined)).toBeUndefined();
  });
});

describe('forwardedMeta', () => {
  it('forwards identity and trace keys', () => {
    const meta = {
      [CLIENT_INFO_META_KEY]: { name: 'claude-code' },
      [CLIENT_CAPABILITIES_META_KEY]: { roots: {} },
      [TRACEPARENT_META_KEY]: TRACEPARENT,
      [TRACESTATE_META_KEY]: 'vendor=1',
      [BAGGAGE_META_KEY]: 'a=1',
    };

    expect(forwardedMeta(meta)).toEqual(meta);
  });

  it('never forwards the protocol version, which describes the other connection', () => {
    const forwarded = forwardedMeta({
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
      [CLIENT_INFO_META_KEY]: { name: 'a' },
    });

    expect(forwarded).toEqual({ [CLIENT_INFO_META_KEY]: { name: 'a' } });
    expect(FORWARDED_META_KEYS).not.toContain(PROTOCOL_VERSION_META_KEY);
  });

  it('drops keys the request did not carry rather than sending undefined', () => {
    expect(forwardedMeta({ [TRACEPARENT_META_KEY]: TRACEPARENT })).toEqual({
      [TRACEPARENT_META_KEY]: TRACEPARENT,
    });
  });

  it('is undefined when there is nothing to forward', () => {
    expect(forwardedMeta({ progressToken: 1 })).toBeUndefined();
    expect(forwardedMeta(undefined)).toBeUndefined();
  });

  it('fills clientInfo from the handshake when the request carried none', () => {
    // The legacy era carries the caller's identity in `initialize`, not in
    // per-request `_meta`, so the fallback is the only way an upstream server
    // on that era ever learns who the real caller is.
    expect(forwardedMeta(undefined, { name: 'claude-code', version: '2' })).toEqual({
      [CLIENT_INFO_META_KEY]: { name: 'claude-code', version: '2' },
    });
  });

  it('lets the request’s own clientInfo win over the handshake fallback', () => {
    const forwarded = forwardedMeta(
      { [CLIENT_INFO_META_KEY]: { name: 'from-request' } },
      { name: 'from-handshake' },
    );

    expect(forwarded).toEqual({ [CLIENT_INFO_META_KEY]: { name: 'from-request' } });
  });

  it('lets an override replace the agent’s traceparent', () => {
    const forwarded = forwardedMeta(
      { [TRACEPARENT_META_KEY]: TRACEPARENT, [TRACESTATE_META_KEY]: 'vendor=1' },
      undefined,
      { traceparent: OVERRIDE_TRACEPARENT },
    );

    // The trace id is the same in both, so `tracestate` still belongs to the
    // trace it is forwarded with: only the span being named changed.
    expect(forwarded).toEqual({
      [TRACEPARENT_META_KEY]: OVERRIDE_TRACEPARENT,
      [TRACESTATE_META_KEY]: 'vendor=1',
    });
  });

  it('adds a traceparent the agent never sent when one is overridden in', () => {
    expect(forwardedMeta(undefined, undefined, { traceparent: OVERRIDE_TRACEPARENT })).toEqual({
      [TRACEPARENT_META_KEY]: OVERRIDE_TRACEPARENT,
    });
  });

  it('treats an absent or empty override as no override at all', () => {
    const meta = { [TRACEPARENT_META_KEY]: TRACEPARENT };

    expect(forwardedMeta(meta, undefined, {})).toEqual(meta);
    expect(forwardedMeta(meta, undefined, { traceparent: '' })).toEqual(meta);
    expect(forwardedMeta(undefined, undefined, { traceparent: '' })).toBeUndefined();
  });
});

describe('splitProgressToken', () => {
  it('peels the token off _meta', () => {
    const split = splitProgressToken({ name: 'echo', _meta: { progressToken: 7, other: 1 } });

    expect(split.progressToken).toBe(7);
    expect(split.params).toEqual({ name: 'echo', _meta: { other: 1 } });
  });

  it('leaves an emptied _meta in place rather than deleting it', () => {
    // Removing the key as well would make the forwarded request differ from the
    // agent's in a second way; an empty `_meta` is valid on both eras.
    expect(splitProgressToken({ _meta: { progressToken: 'x' } }).params).toEqual({ _meta: {} });
  });

  it('accepts a string token', () => {
    expect(splitProgressToken({ _meta: { progressToken: 'abc' } }).progressToken).toBe('abc');
  });

  it('drops a token that is neither string nor number', () => {
    const split = splitProgressToken({ _meta: { progressToken: { nope: true } } });

    expect(split.progressToken).toBeUndefined();
    // The malformed key is still stripped: forwarding it would earn an
    // "unknown token" from the upstream SDK.
    expect(split.params).toEqual({ _meta: {} });
  });

  it('returns the params untouched when there is no token', () => {
    const params = { name: 'echo', _meta: { other: 1 } };

    expect(splitProgressToken(params).params).toBe(params);
  });

  it('returns the params untouched when there is no _meta', () => {
    const params = { name: 'echo' };

    expect(splitProgressToken(params).params).toBe(params);
  });

  it('handles absent params', () => {
    expect(splitProgressToken(undefined)).toEqual({ params: undefined, progressToken: undefined });
  });

  it('ignores a null _meta', () => {
    const params = { _meta: null };

    expect(splitProgressToken(params).params).toBe(params);
  });
});

describe('upstreamParams', () => {
  it('merges the forwarded keys over surviving _meta', () => {
    const merged = upstreamParams(
      { name: 'echo', _meta: { other: 1 } },
      {
        [TRACEPARENT_META_KEY]: TRACEPARENT,
      },
    );

    expect(merged).toEqual({
      name: 'echo',
      _meta: { other: 1, [TRACEPARENT_META_KEY]: TRACEPARENT },
    });
  });

  it('creates _meta when the request had none', () => {
    expect(upstreamParams({ name: 'echo' }, { [TRACEPARENT_META_KEY]: TRACEPARENT })).toEqual({
      name: 'echo',
      _meta: { [TRACEPARENT_META_KEY]: TRACEPARENT },
    });
  });

  it('returns the params unchanged when there is nothing to forward', () => {
    const params = { name: 'echo' };

    expect(upstreamParams(params, undefined)).toBe(params);
  });

  it('carries the handshake clientInfo fallback through', () => {
    expect(upstreamParams({ name: 'echo' }, undefined, { name: 'claude-code' })).toEqual({
      name: 'echo',
      _meta: { [CLIENT_INFO_META_KEY]: { name: 'claude-code' } },
    });
  });

  it('carries a traceparent override through', () => {
    expect(
      upstreamParams({ name: 'echo' }, { [TRACEPARENT_META_KEY]: TRACEPARENT }, undefined, {
        traceparent: OVERRIDE_TRACEPARENT,
      }),
    ).toEqual({ name: 'echo', _meta: { [TRACEPARENT_META_KEY]: OVERRIDE_TRACEPARENT } });
  });

  it('is identical with an absent override and with no override argument', () => {
    // The regression that would hurt: an override seam must cost nothing on the
    // wire when nobody uses it.
    const params = { name: 'echo', _meta: { other: 1 } };
    const meta = { [TRACEPARENT_META_KEY]: TRACEPARENT };

    const bare = { name: 'echo' };

    expect(upstreamParams(params, meta, undefined, undefined)).toEqual(
      upstreamParams(params, meta),
    );
    // Nothing to forward and nothing to override: the agent's own object, not
    // a copy of it.
    expect(upstreamParams(bare, undefined, undefined, {})).toBe(bare);
  });
});

describe('RequestRemap', () => {
  it('starts empty', () => {
    expect(new RequestRemap().size).toBe(0);
  });

  it('remembers the progress token for an in-flight request', () => {
    const remap = new RequestRemap();
    remap.begin(1, 'downstream-token');

    expect(remap.progressTokenFor(1)).toBe('downstream-token');
    expect(remap.get(1)).toEqual({
      downstreamRequestId: 1,
      downstreamProgressToken: 'downstream-token',
    });
    expect(remap.size).toBe(1);
  });

  it('tracks a request that asked for no progress', () => {
    const remap = new RequestRemap();
    remap.begin('req-1');

    expect(remap.size).toBe(1);
    expect(remap.progressTokenFor('req-1')).toBeUndefined();
    expect(remap.get('req-1')).toEqual({
      downstreamRequestId: 'req-1',
      downstreamProgressToken: undefined,
    });
  });

  it('leaks nothing once a request settles', () => {
    const remap = new RequestRemap();
    remap.begin(1, 7);
    remap.settle(1);

    expect(remap.size).toBe(0);
    expect(remap.progressTokenFor(1)).toBeUndefined();
    expect(remap.get(1)).toBeUndefined();
  });

  it('is idempotent on a second settle', () => {
    const remap = new RequestRemap();
    remap.begin(1, 7);
    remap.settle(1);
    remap.settle(1);

    expect(remap.size).toBe(0);
  });

  it('settling an unknown id is a no-op', () => {
    const remap = new RequestRemap();
    remap.settle('never-seen');

    expect(remap.size).toBe(0);
  });

  it('holds many requests apart and drains to empty', () => {
    const remap = new RequestRemap();
    for (let id = 0; id < 100; id += 1) remap.begin(id, `t${id}`);

    expect(remap.size).toBe(100);
    expect(remap.progressTokenFor(42)).toBe('t42');

    for (let id = 0; id < 100; id += 1) remap.settle(id);

    expect(remap.size).toBe(0);
  });

  it('replaces an entry when the same id is begun twice', () => {
    const remap = new RequestRemap();
    remap.begin(1, 'first');
    remap.begin(1, 'second');

    expect(remap.size).toBe(1);
    expect(remap.progressTokenFor(1)).toBe('second');
  });

  it('clears everything for connection teardown', () => {
    const remap = new RequestRemap();
    remap.begin(1, 'a');
    remap.begin(2, 'b');
    remap.clear();

    expect(remap.size).toBe(0);
  });
});
