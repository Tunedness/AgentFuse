#!/usr/bin/env node
// Rewrites the exported `*_VERSION` constants so they match the package manifests.
//
// `changeset version` moves only `package.json`. The constants stay separate
// literals on purpose (no package reads JSON or a file at runtime to learn its
// own version), so something has to carry the manifest number over to them.
// `npm run version` runs this right after `changeset version`.
//
//   node scripts/sync-versions.mjs           rewrite the constants
//   node scripts/sync-versions.mjs --check   report drift, exit 1 if there is any

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);

/** One entry per published package: where the manifest is and which constant mirrors it. */
const TARGETS = [
  { dir: 'packages/core', constant: 'CORE_VERSION', file: 'src/version.ts' },
  { dir: 'packages/proxy', constant: 'PROXY_VERSION', file: 'src/version.ts' },
  { dir: 'packages/embeddings-local', constant: 'EMBEDDINGS_LOCAL_VERSION', file: 'src/index.ts' },
  { dir: 'packages/cli', constant: 'CLI_VERSION', file: 'src/index.ts' },
];

const check = process.argv.includes('--check');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--check');
if (unknown.length > 0) {
  console.error(`sync-versions: unknown argument ${unknown.join(' ')}`);
  process.exit(2);
}

// First pass: read and validate every target, and work out the new file contents.
// Nothing is written until all four have passed, so a bad manifest or a missing
// literal in the last package cannot leave the first three already rewritten.
const changes = [];

for (const { dir, constant, file } of TARGETS) {
  const manifest = JSON.parse(readFileSync(new URL(`${dir}/package.json`, ROOT), 'utf8'));
  const version = manifest.version;
  if (typeof version !== 'string' || version === '') {
    console.error(`sync-versions: ${dir}/package.json has no version`);
    process.exit(2);
  }

  const path = new URL(`${dir}/${file}`, ROOT);
  const source = readFileSync(path, 'utf8');
  const pattern = new RegExp(`(\\b${constant} = ')([^']*)(')`);
  const match = pattern.exec(source);
  if (!match) {
    console.error(`sync-versions: ${dir}/${file} has no \`${constant} = '...'\` literal`);
    process.exit(2);
  }

  const current = match[2];
  if (current === version) continue;

  changes.push({
    path,
    constant,
    current,
    version,
    where: fileURLToPath(path).replace(fileURLToPath(ROOT), ''),
    next: source.replace(pattern, (_all, head, _old, tail) => `${head}${version}${tail}`),
  });
}

const drifted = changes.length;

// Second pass: report or write.
for (const { path, constant, current, version, where, next } of changes) {
  if (check) {
    console.error(`${where}: ${constant} is ${current}, manifest says ${version}`);
  } else {
    writeFileSync(path, next);
    console.log(`${where}: ${constant} ${current} -> ${version}`);
  }
}

if (check && drifted > 0) {
  console.error('Run `node scripts/sync-versions.mjs` to bring the constants in line.');
  process.exit(1);
}
if (drifted === 0) console.log('sync-versions: constants already match the manifests');
