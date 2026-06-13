#!/usr/bin/env node
// calmcp entry point. Parses CLI flags, loads configuration from the environment, and starts the
// requested transport: stdio (default, for local MCP clients) or Streamable HTTP (for BTP / remote).

import 'dotenv/config';
import { Command } from 'commander';
import { Config } from './config.js';
import { createLogger } from './logging.js';
import { buildMcpServer, createClients } from './server.js';
import { createHttpApp } from './transport/http.js';
import { startStdio } from './transport/stdio.js';

/** Default HTTP port when neither `--port` nor `PORT` is set. */
const DEFAULT_PORT = 8080;
/** Default per-client rate limit (requests/minute) for the HTTP transport. */
const DEFAULT_RATE_LIMIT = 120;

/** CLI options parsed by commander. */
interface CliOptions {
  http?: boolean;
  port?: string;
}

/** Parse the CORS origins env var into a value the `cors` middleware accepts. */
function parseCorsOrigins(value: string | undefined): string | string[] {
  if (!value || value.trim() === '*') {
    return '*';
  }
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('calmcp')
    .description('Read-only Model Context Protocol server for SAP Cloud ALM')
    .option('--http', 'run the Streamable HTTP transport (default: stdio)')
    .option('-p, --port <port>', 'HTTP port (HTTP transport only)')
    .parse();
  const options = program.opts<CliOptions>();

  const config = Config.fromEnv();
  const logger = createLogger(config.debug);
  // The Cloud ALM clients (and their token caches) are created once and shared across requests.
  const clients = createClients(config, logger);

  const useHttp = options.http === true || process.env.CALM_TRANSPORT === 'http';

  if (useHttp) {
    const port = Number(options.port ?? process.env.PORT ?? DEFAULT_PORT);
    const app = createHttpApp({
      buildServer: () => buildMcpServer(clients, logger),
      corsOrigins: parseCorsOrigins(process.env.CALM_CORS_ORIGINS),
      rateLimitPerMinute: DEFAULT_RATE_LIMIT,
      logger,
    });
    app.listen(port, () => {
      logger.info({ port }, 'calmcp HTTP transport listening');
    });
  } else {
    const server = buildMcpServer(clients, logger);
    await startStdio(server, logger);
  }
}

main().catch((error) => {
  // The logger may not exist yet if config failed; write the fatal error to stderr directly.
  process.stderr.write(`calmcp failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});
