import { describe, expect, it } from 'vitest';
import { readAnnotations, ToolCatalogue } from './annotations.js';

/**
 * These hints are written by the upstream server, which is the component
 * AgentFuse exists to be sceptical of. So the interesting cases here are not
 * the well-formed ones: they are a server that sends a string where a boolean
 * belongs, a tool entry with no name, and a `tools/list` that fails outright.
 */

describe('reading one tool’s annotations', () => {
  it('keeps the four hints and the title', () => {
    expect(
      readAnnotations({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        title: 'Read a file',
      }),
    ).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
      title: 'Read a file',
    });
  });

  it('drops a hint that is not a boolean rather than coercing it', () => {
    // `"yes"` is truthy, and a server that sends it must not end up having
    // claimed `readOnlyHint: true`.
    expect(readAnnotations({ readOnlyHint: 'yes', idempotentHint: true })).toEqual({
      idempotentHint: true,
    });
  });

  it('drops a title that is not a string', () => {
    expect(readAnnotations({ title: 42, readOnlyHint: true })).toEqual({ readOnlyHint: true });
  });

  it('ignores keys the engine has no field for', () => {
    expect(readAnnotations({ readOnlyHint: true, futureHint: true })).toEqual({
      readOnlyHint: true,
    });
  });

  it.each([undefined, null, 'annotations', 7, {}, { readOnlyHint: 1 }])(
    'answers undefined for %j',
    (value) => {
      expect(readAnnotations(value)).toBeUndefined();
    },
  );
});

describe('the catalogue', () => {
  it('fetches nothing when the policy does not trust hints', async () => {
    let listed = 0;
    const catalogue = new ToolCatalogue({ trustHints: false });

    await catalogue.prime({
      listTools: () => {
        listed += 1;
        return Promise.resolve({ tools: [{ name: 'echo', annotations: { readOnlyHint: true } }] });
      },
    });

    expect(listed).toBe(0);
    expect(catalogue.trustHints).toBe(false);
    expect(catalogue.annotationsFor('echo')).toBeUndefined();
  });

  it('fetches once and answers from the cache after', async () => {
    let listed = 0;
    const catalogue = new ToolCatalogue({ trustHints: true });
    const lister = {
      listTools: () => {
        listed += 1;
        return Promise.resolve({
          tools: [
            { name: 'echo', annotations: { idempotentHint: true } },
            { name: 'write', annotations: { destructiveHint: true } },
            { name: 'plain' },
          ],
        });
      },
    };

    await catalogue.prime(lister);
    await catalogue.prime(lister);

    expect(listed).toBe(1);
    expect(catalogue.size).toBe(2);
    expect(catalogue.annotationsFor('echo')).toEqual({ idempotentHint: true });
    expect(catalogue.annotationsFor('plain')).toBeUndefined();
  });

  it('reports how much it found', async () => {
    const events: Array<[string, Record<string, unknown>]> = [];
    const catalogue = new ToolCatalogue({
      trustHints: true,
      onEvent: (event, fields) => events.push([event, fields]),
    });

    await catalogue.prime({
      listTools: () => Promise.resolve({ tools: [{ name: 'echo' }] }),
    });

    expect(events).toEqual([['tool_catalogue', { tools: 1, annotated: 0 }]]);
  });

  it('skips a tool entry with no usable name', async () => {
    const catalogue = new ToolCatalogue({ trustHints: true });

    await catalogue.prime({
      listTools: () =>
        Promise.resolve({
          tools: [
            { annotations: { readOnlyHint: true } },
            { name: '', annotations: { readOnlyHint: true } },
            { name: 42, annotations: { readOnlyHint: true } },
            null,
          ],
        }),
    });

    expect(catalogue.size).toBe(0);
  });

  it('survives a tools/list that throws, and says so', async () => {
    const events: string[] = [];
    const catalogue = new ToolCatalogue({
      trustHints: true,
      onEvent: (event, fields) => events.push(`${event}:${String(fields['message'])}`),
    });

    await catalogue.prime({ listTools: () => Promise.reject(new Error('no tools here')) });

    expect(events).toEqual(['tool_catalogue_failed:no tools here']);
    expect(catalogue.size).toBe(0);
  });

  it('survives a rejection that is not an Error', async () => {
    const events: string[] = [];
    const catalogue = new ToolCatalogue({
      trustHints: true,
      onEvent: (event, fields) => events.push(`${event}:${String(fields['message'])}`),
    });

    // A module whose `throw 'x'` rejected is not an `Error`; `messageOf`'s own
    // test has the precedent for caring about that.
    await catalogue.prime({ listTools: () => Promise.reject('nope') });

    expect(events).toEqual(['tool_catalogue_failed:nope']);
  });

  it.each([{}, { tools: 'many' }, null])('survives a tools/list shaped like %j', async (result) => {
    const events: string[] = [];
    const catalogue = new ToolCatalogue({
      trustHints: true,
      onEvent: (event) => events.push(event),
    });

    await catalogue.prime({ listTools: () => Promise.resolve(result) });

    expect(events).toEqual(['tool_catalogue_failed']);
    expect(catalogue.size).toBe(0);
  });
});
