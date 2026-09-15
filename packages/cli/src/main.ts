#!/usr/bin/env node
import { versionBanner } from './index.js';

// TODO(phase-3): real argument parsing and the `agentfuse run -- <server cmd>`
// entry point land here. For now the binary only proves the wiring works.
process.stdout.write(`${versionBanner()}\n`);
