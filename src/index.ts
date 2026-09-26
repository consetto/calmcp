#!/usr/bin/env node
// calmcp entry point. Parses CLI flags, loads configuration from the environment, and starts the
// requested transport: stdio (default, for local MCP clients) or Streamable HTTP (for BTP / remote).

import 'dotenv/config';
import { loadXsuaaCredentials, resolveAppUrl, type XsuaaCredentials } from '@arc-mcp/xsuaa-auth';
import { Command } from 'commander';
import { Config } from './config.js';
import { createLogger } from './logging.js';
import { buildMcpServer, createClients, VIEWER_SCOPE, WRITER_SCOPE } from './server.js';
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

/**
 * Parse the CORS origins env var into a value the `cors` middleware accepts. Unset means no CORS
 * headers: MCP clients call the endpoint server-side, so only browser-based clients need an entry.
 */
function parseCorsOrigins(value: string | undefined): string | string[] | false {
  if (!value?.trim()) {
    return false;
  }
  if (value.trim() === '*') {
    return '*';
  }
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Load the XSUAA credentials when an xsuaa service is bound. A bound but unreadable binding is a
 * startup error rather than a silent fall-back to weaker (or no) authentication.
 */
function loadXsuaaIfBound(): XsuaaCredentials | undefined {
  const raw = process.env.VCAP_SERVICES;
  if (!raw) {
    return undefined;
  }
  let bound = false;
  try {
    bound = Object.hasOwn(JSON.parse(raw) as object, 'xsuaa');
  } catch {
    throw new Error('VCAP_SERVICES is not valid JSON');
  }
  return bound ? loadXsuaaCredentials() : undefined;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('calmcp')
    .description(
      'Model Context Protocol server for SAP Cloud ALM (read-only unless CALM_WRITE_ENABLED=true)',
    )
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
    const onCloudFoundry = Boolean(process.env.VCAP_APPLICATION);
    // Protect /mcp with a static API key (CALM_HTTP_API_KEY) and/or XSUAA + MCP-native OAuth when an
    // XSUAA service is bound (BTP). Without either, startup fails unless the operator explicitly opts
    // into an open endpoint for local development, which is then bound to loopback only. On Cloud
    // Foundry the opt-in is ignored: a lost xsuaa binding must never expose Cloud ALM publicly.
    const allowOpen = !onCloudFoundry && process.env.CALM_HTTP_ALLOW_UNAUTHENTICATED === 'true';
    const xsuaaCredentials = loadXsuaaIfBound();
    const httpApiKey = process.env.CALM_HTTP_API_KEY?.trim() || undefined;
    const open = !xsuaaCredentials && !httpApiKey;
    if (open && !allowOpen) {
      throw new Error(
        'HTTP transport needs authentication: bind an XSUAA service or set CALM_HTTP_API_KEY. ' +
          'For local development only, CALM_HTTP_ALLOW_UNAUTHENTICATED=true serves /mcp on ' +
          '127.0.0.1 without auth.',
      );
    }
    const app = createHttpApp({
      buildServer: (authInfo) => buildMcpServer(clients, logger, authInfo),
      corsOrigins: parseCorsOrigins(process.env.CALM_CORS_ORIGINS),
      rateLimitPerMinute: DEFAULT_RATE_LIMIT,
      logger,
      requireAuth: !allowOpen,
      localOnly: open,
      trustProxy: onCloudFoundry,
      auth: {
        // Entry form (not a bare string) so the key carries the Viewer scope and passes
        // requiredScopes when XSUAA is also bound. Never Writer: the key is shared and static.
        apiKeys: httpApiKey ? [{ key: httpApiKey, scopes: [VIEWER_SCOPE] }] : undefined,
        xsuaa: xsuaaCredentials
          ? {
              credentials: xsuaaCredentials,
              appUrl: resolveAppUrl(process.env, { publicUrlEnvVar: 'CALM_PUBLIC_URL', port }),
              clientIdPrefix: 'calmcp-',
              dcrKdfLabel: 'calmcp-dcr/v1',
              stateKdfLabel: 'calmcp-oauth-state/v1',
              scopesSupported: [VIEWER_SCOPE, WRITER_SCOPE],
              requiredScopes: [VIEWER_SCOPE],
              resourceName: 'calmcp (SAP Cloud ALM MCP Server)',
              dcrSigningSecret:
                process.env.CALM_DCR_SIGNING_SECRET?.trim() || xsuaaCredentials.clientsecret,
            }
          : undefined,
      },
    });
    const onListening = () =>
      logger.info({ port, loopbackOnly: open }, 'calmcp HTTP transport listening');
    if (open) {
      app.listen(port, '127.0.0.1', onListening);
    } else {
      app.listen(port, onListening);
    }
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
