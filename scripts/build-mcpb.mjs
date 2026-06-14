#!/usr/bin/env node
// Build the calmcp Claude Desktop one-click bundle (.mcpb).
//
// Assembles a self-contained bundle directory (manifest + compiled dist/ + production node_modules),
// then validates and packs it with the pinned MCPB CLI. Cross-platform (macOS / Windows / Linux);
// calmcp has no native dependencies, so a single bundle runs everywhere.
//
// Usage: npm run build:mcpb   (runs `npm run build` first via the package.json script)
// Output: calmcp-<version>.mcpb in the repo root.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pin the MCPB CLI (not @latest) so the bundle is reproducible and a CLI change can't break a build.
const MCPB = '@anthropic-ai/mcpb@2.1.2';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundleDir = join(root, 'mcpb-bundle');

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'mcpb-manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  throw new Error(
    `Version mismatch: mcpb-manifest.json is ${manifest.version} but package.json is ${pkg.version}. ` +
      'Keep them in sync.',
  );
}
const outFile = join(root, `calmcp-${pkg.version}.mcpb`);

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, shell: process.platform === 'win32', ...opts });

console.log('• Assembling bundle directory…');
rmSync(bundleDir, { recursive: true, force: true });
mkdirSync(bundleDir, { recursive: true });
// MCPB expects the manifest at the bundle root as `manifest.json`.
cpSync(join(root, 'mcpb-manifest.json'), join(bundleDir, 'manifest.json'));
cpSync(join(root, 'dist'), join(bundleDir, 'dist'), { recursive: true });
cpSync(join(root, 'package.json'), join(bundleDir, 'package.json'));
cpSync(join(root, 'package-lock.json'), join(bundleDir, 'package-lock.json'));

console.log('• Installing production dependencies into the bundle…');
run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: bundleDir });

console.log('• Validating manifest…');
run('npx', ['--yes', MCPB, 'validate', join(bundleDir, 'manifest.json')]);

console.log('• Packing .mcpb…');
run('npx', ['--yes', MCPB, 'pack', bundleDir, outFile]);

rmSync(bundleDir, { recursive: true, force: true });
console.log(`\n✓ Built ${outFile}`);
