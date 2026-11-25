// The env file calmcp reads only when `--dotenv` names it (src/envFile.ts).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadEnvFile, unreadEnvFileHint } from '../../src/envFile.js';
import { ConfigError } from '../../src/errors.js';

describe('loadEnvFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'calmcp-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds the variables of the named file', () => {
    const file = join(dir, 'settings.env');
    writeFileSync(file, 'CALM_TENANT=acme\nCALM_REGION="eu10"\n# a comment\n');
    const env: NodeJS.ProcessEnv = {};
    loadEnvFile(file, env);
    expect(env).toEqual({ CALM_TENANT: 'acme', CALM_REGION: 'eu10' });
  });

  it('keeps a variable that is already set', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'CALM_WRITE_ENABLED=true\nCALM_TENANT=acme\n');
    const env: NodeJS.ProcessEnv = { CALM_WRITE_ENABLED: 'false' };
    loadEnvFile(file, env);
    expect(env).toEqual({ CALM_WRITE_ENABLED: 'false', CALM_TENANT: 'acme' });
  });

  it('refuses a file it cannot read, naming it', () => {
    const file = join(dir, 'missing.env');
    const attempt = () => loadEnvFile(file, {});
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(`--dotenv: cannot read '${file}' (ENOENT)`);
  });

  it('writes nothing to stdout, which is the MCP channel over stdio', () => {
    const file = join(dir, '.env');
    writeFileSync(file, 'CALM_TENANT=acme\n');
    const written: unknown[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      loadEnvFile(file, {});
    } finally {
      process.stdout.write = write;
    }
    expect(written).toEqual([]);
  });
});

describe('unreadEnvFileHint', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'calmcp-env-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('points to --dotenv when a .env lies unread in the working directory', () => {
    writeFileSync(join(dir, '.env'), 'CALM_TENANT=acme\n');
    expect(unreadEnvFileHint(false, dir)).toContain('--dotenv');
  });

  it('says nothing without a .env, or when --dotenv was given', () => {
    expect(unreadEnvFileHint(false, dir)).toBe('');
    writeFileSync(join(dir, '.env'), 'CALM_TENANT=acme\n');
    expect(unreadEnvFileHint(true, dir)).toBe('');
  });
});
