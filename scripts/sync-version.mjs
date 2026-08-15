#!/usr/bin/env node
// Propagate the version in package.json to every other file that carries it.
//
// The version lives in five places: package.json (the source of truth), mcpb-manifest.json (Claude
// Desktop bundle), mta.yaml (the MTA archive name and the version `cf deploy` reports), and
// src/server.ts (advertised to MCP clients on connect). Left to hand-editing they drift, and a
// stale mta.yaml makes every deploy report the same version, which destroys deploy provenance.
//
// Usage:
//   node scripts/sync-version.mjs          rewrite the targets to match package.json
//   node scripts/sync-version.mjs --check  exit non-zero if any target is out of sync (CI)
//
// Run automatically by `npm version <patch|minor|major>` via the `version` lifecycle script.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Files carrying a copy of the version, each with the pattern locating it. */
const targets = [
  {
    file: 'mcpb-manifest.json',
    // "version": "0.1.0"
    pattern: /("version"\s*:\s*")([^"]+)(")/,
  },
  {
    file: 'mta.yaml',
    // version: 0.1.0   (at the start of a line, so `_schema-version:` is not matched)
    pattern: /^(version:\s*)(\S+)()$/m,
  },
  {
    file: 'src/server.ts',
    // const SERVER_VERSION = '0.1.0';
    pattern: /(const SERVER_VERSION = ')([^']+)(')/,
  },
];

let drifted = 0;

for (const { file, pattern } of targets) {
  const path = join(root, file);
  const before = readFileSync(path, 'utf8');
  const match = before.match(pattern);

  if (!match) {
    console.error(`✗ ${file}: version marker not found — update scripts/sync-version.mjs`);
    process.exitCode = 1;
    continue;
  }

  const current = match[2];
  if (current === version) {
    console.log(`✓ ${file}: ${version}`);
    continue;
  }

  drifted += 1;
  if (check) {
    console.error(`✗ ${file}: ${current} (expected ${version})`);
    continue;
  }

  writeFileSync(path, before.replace(pattern, `$1${version}$3`));
  console.log(`↑ ${file}: ${current} → ${version}`);
}

if (check && drifted > 0) {
  console.error(
    `\n${drifted} file(s) out of sync with package.json (${version}). ` +
      'Run `node scripts/sync-version.mjs` and commit the result.',
  );
  process.exitCode = 1;
}
