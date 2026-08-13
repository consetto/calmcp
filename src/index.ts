#!/usr/bin/env node
// calmcp entry point. Parses CLI flags, loads configuration from the environment, and starts the
// requested transport: stdio (default, for local MCP clients) or Streamable HTTP (for BTP / remote).

import 'dotenv/config';
import { loadXsuaaCredentials, resolveAppUrl, type XsuaaCredentials } from '@arc-mcp/xsuaa-auth';
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
    // Protect /mcp with a static API key (CALM_HTTP_API_KEY) and/or XSUAA + MCP-native OAuth when an
    // XSUAA service is bound (BTP). With neither configured (local dev) the endpoint is left open;
    // createHttpApp logs a warning in that case.
    //
    // loadXsuaaCredentials throws when no complete xsuaa binding is present, so guard it: an unbound
    // app falls back to API-key-only (or open) instead of crashing at startup.
    let xsuaaCredentials: XsuaaCredentials | undefined;
    if (process.env.VCAP_SERVICES) {
      try {
        xsuaaCredentials = loadXsuaaCredentials();
      } catch (err) {
        logger.warn(
          { err: (err as Error).message },
          'XSUAA service not bound or incomplete — HTTP XSUAA auth disabled',
        );
      }
    }
    const httpApiKey = process.env.CALM_HTTP_API_KEY?.trim() || undefined;
    const app = createHttpApp({
      buildServer: () => buildMcpServer(clients, logger),
      corsOrigins: parseCorsOrigins(process.env.CALM_CORS_ORIGINS),
      rateLimitPerMinute: DEFAULT_RATE_LIMIT,
      logger,
      auth: {
        // Entry form (not a bare string) so the key carries the Viewer scope and passes
        // requiredScopes when XSUAA is also bound.
        apiKeys: httpApiKey ? [{ key: httpApiKey, scopes: ['Viewer'] }] : undefined,
        xsuaa: xsuaaCredentials
          ? {
              credentials: xsuaaCredentials,
              appUrl: resolveAppUrl(process.env, { publicUrlEnvVar: 'CALM_PUBLIC_URL', port }),
              clientIdPrefix: 'calmcp-',
              dcrKdfLabel: 'calmcp-dcr/v1',
              stateKdfLabel: 'calmcp-oauth-state/v1',
              scopesSupported: ['Viewer'],
              requiredScopes: ['Viewer'],
              resourceName: 'calmcp (SAP Cloud ALM MCP Server)',
              dcrSigningSecret:
                process.env.CALM_DCR_SIGNING_SECRET?.trim() || xsuaaCredentials.clientsecret,
            }
          : undefined,
      },
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
