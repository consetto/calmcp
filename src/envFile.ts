// Reading settings from an env file, which calmcp does only when `--dotenv` names one.
//
// calmcp used to read `.env` from the working directory on every start. An MCP host often starts a
// stdio server in the folder of the project the user has open, so a `.env` in a repository someone
// else wrote could set whatever the host had left unset: `CALM_WRITE_ENABLED`,
// `CALM_UPDATE_ENABLED`, `NODE_TLS_REJECT_UNAUTHORIZED`. A file is therefore read only when the
// operator names it. The option is not called `--env-file`: Node reads a flag of that name itself,
// wherever it stands on the command line, and ends with its own error when the file is missing.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { ConfigError } from './errors.js';

/**
 * Add the variables of an env file to the environment. A variable that is already set keeps its
 * value, as with every env file loader: what the host passes wins over the file.
 *
 * @param path - The file, as given to `--dotenv` (relative paths are read from the working
 *   directory).
 * @param env - The environment to fill (defaults to `process.env`).
 * @throws {ConfigError} When the file cannot be read: a file the operator named and calmcp skipped
 *   would start a server with other settings than the ones configured.
 */
export function loadEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): void {
  const { error } = dotenv.config({ path, quiet: true, processEnv: env });
  if (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? error.message;
    throw ConfigError.invalid(`--dotenv: cannot read '${path}' (${reason})`);
  }
}

/**
 * What to add to a configuration error when a `.env` lies in the working directory and no
 * `--dotenv` was given: most likely the settings are in that file, which is no longer read.
 *
 * @param envFileGiven - Whether `--dotenv` was passed.
 * @param cwd - The working directory.
 * @returns The hint, or an empty string.
 */
export function unreadEnvFileHint(envFileGiven: boolean, cwd = process.cwd()): string {
  if (envFileGiven || !existsSync(resolve(cwd, '.env'))) return '';
  return (
    ' There is a .env file in the working directory; calmcp reads an env file only when ' +
    '--dotenv names it (e.g. --dotenv .env).'
  );
}
