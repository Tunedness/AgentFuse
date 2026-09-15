/**
 * Glob matching for policy `match` patterns.
 *
 * The grammar is deliberately tiny — `*` and `?` — because a policy rule is
 * read under pressure during an incident and nobody should have to reason about
 * globstar semantics to know whether `shell__*` covers `shell__exec`.
 *
 * `*` matches any run of characters **including** `_`, so `*__delete_*` matches
 * `db__delete_row` and `*` matches everything. Patterns are anchored at both
 * ends: `shell__*` does not match `my_shell__exec`.
 */

/** Everything that means something to a regex, minus the two we implement. */
const META = /[.+^${}()|[\]\\]/g;

/**
 * Compiles a glob into an anchored `RegExp`.
 *
 * Called once per rule at policy-load time. The hot path must never build a
 * regex — see `compilePolicy()`.
 */
export function compileGlob(pattern: string): RegExp {
  let source = '';
  for (const char of pattern) {
    if (char === '*') source += '.*';
    else if (char === '?') source += '.';
    else source += char.replace(META, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/** Convenience wrapper; compiles on every call, so never use it on the hot path. */
export function globMatches(pattern: string, subject: string): boolean {
  return compileGlob(pattern).test(subject);
}

/**
 * The string rules match against.
 *
 * `<server>__<tool>` is MCP's own convention for namespacing a tool behind an
 * aggregating proxy, so a policy written for AgentFuse reads the same as the
 * tool names the agent already sees.
 */
export function toolKey(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}
