/**
 * Writes the labelled corpus to `bench/detection/corpus.jsonl`.
 *
 * Run with `npm run bench:corpus --workspace @agentfuse/bench`. The file is
 * committed, and `corpus.test.ts` hashes the generator's output against it, so
 * regenerating is a deliberate act with a visible diff — which it has to be,
 * because the calibrated thresholds were fitted to those exact bytes.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCorpus, toJsonl } from './corpus.js';

const OUT = fileURLToPath(new URL('../../detection/corpus.jsonl', import.meta.url));

const sessions = generateCorpus();
const jsonl = toJsonl(sessions);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, jsonl, 'utf8');

const calls = sessions.reduce((sum, session) => sum + session.calls.length, 0);
process.stdout.write(
  `wrote ${sessions.length} sessions (${calls} calls, ${jsonl.length} bytes) to ${OUT}\n`,
);
