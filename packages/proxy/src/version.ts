/**
 * The proxy's contract version.
 *
 * Its own constant rather than a read of `package.json`, for the same reason
 * `CORE_VERSION` is: this package is ESM with `verbatimModuleSyntax`, importing
 * JSON would add a resolution mode to think about, and reading a file would put
 * `node:fs` into a package whose stdio discipline is the point.
 */
export const PROXY_VERSION = '0.0.0';
