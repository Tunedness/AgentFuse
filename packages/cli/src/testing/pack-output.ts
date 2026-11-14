/**
 * Reads the stdout of `npm pack --json --workspaces`.
 *
 * npm 10 and 11 print an array with one entry per workspace. npm 12 prints an
 * object keyed by package name instead. Both are the same entries, so both are
 * accepted and the caller always gets an array.
 */
export function parsePackOutput<T>(stdout: string): T[] {
  const parsed = JSON.parse(stdout) as T[] | Record<string, T>;
  return Array.isArray(parsed) ? parsed : Object.values(parsed);
}
