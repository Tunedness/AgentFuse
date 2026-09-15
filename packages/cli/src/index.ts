import { CORE_VERSION } from '@agentfuse/core';
import { PROXY_VERSION } from '@agentfuse/proxy';

/** Version of the `agentfuse` command line tool. */
export const CLI_VERSION = '0.0.0';

/**
 * One-line version string printed by `agentfuse --version`.
 *
 * The workspace versions packages independently, so the CLI reports the three
 * that actually shipped together rather than a single number.
 */
export function versionBanner(): string {
  return `agentfuse ${CLI_VERSION} (core ${CORE_VERSION}, proxy ${PROXY_VERSION})`;
}
