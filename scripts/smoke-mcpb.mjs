#!/usr/bin/env node
// Smoke-test a built .mcpb bundle: unpack it outside the repo (so nothing can resolve from the
// repo's own node_modules), start the server exactly as Claude Desktop would, and check that it
// answers `tools/list` with the four read tools. Catches a bundle missing a runtime dependency or
// a broken entry point before it reaches a release.
//
// Usage: node scripts/smoke-mcpb.mjs calmcp-<version>.mcpb

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const EXPECTED_TOOLS = ['calm_analytics', 'calm_get', 'calm_list', 'calm_resources'];

const bundle = process.argv[2];
if (!bundle) {
  console.error('usage: smoke-mcpb.mjs <file.mcpb>');
  process.exit(2);
}

const dir = mkdtempSync(join(tmpdir(), 'calmcp-smoke-'));
try {
  execFileSync('unzip', ['-q', resolve(bundle), '-d', dir], { stdio: 'inherit' });
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(dir, manifest.server.entry_point)],
    // Sandbox mode needs no tenant; no request reaches Cloud ALM during tools/list.
    env: { PATH: process.env.PATH ?? '', CALM_SANDBOX: 'true', CALM_API_KEY: 'smoke-test' },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'calmcp-smoke', version: manifest.version });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();

  const names = tools.map((tool) => tool.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
    throw new Error(`unexpected tools: ${names.join(', ')}`);
  }
  console.log(`✓ ${bundle}: server ${manifest.version} starts and lists ${names.join(', ')}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
