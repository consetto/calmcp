// Streamable HTTP transport. Exposes the MCP server over HTTP for remote clients and for SAP BTP
// Cloud Foundry deployment. Hardened with helmet, CORS and rate limiting, and provides a `/health`
// endpoint for the Cloud Foundry health check.
//
// The server runs in stateless mode: each POST /mcp builds a fresh MCP server (reusing the shared
// Cloud ALM clients) and a single-shot transport. This keeps horizontal scaling on BTP simple.
//
// When `auth` is supplied (XSUAA bound on BTP), `/mcp` requires a valid bearer token carrying the
// read scope, and the MCP-native OAuth proxy (RFC 8414 discovery + RFC 7591 DCR delegated to XSUAA)
// is mounted so clients like Claude Desktop authenticate automatically. With `requireAuth` a missing
// auth method is a startup error; otherwise `/mcp` is open (local development only), a warning is
// logged, and `localOnly` should restrict it to loopback Host headers (DNS-rebinding protection).

import { type Logger as AuthLogger, type AuthOptions, setupHttpAuth } from '@arc-mcp/xsuaa-auth';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { localhostHostValidation } from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { Logger } from 'pino';

/** Options for the HTTP app. */
export interface HttpAppOptions {
  /**
   * Factory creating a fresh MCP server per request (clients are shared/captured by the factory).
   * Receives the verified caller (undefined when `/mcp` is unauthenticated) so it can decide which
   * tools that caller gets.
   */
  buildServer: (authInfo?: AuthInfo) => McpServer;
  /** Exact allowed CORS origins, or `false` to send no CORS headers at all. Never a wildcard. */
  corsOrigins: string[] | false;
  /** Max requests per minute per client (rate limit). */
  rateLimitPerMinute: number;
  /** Application logger. */
  logger: Logger;
  /**
   * Authentication for `/mcp` (API key and/or XSUAA OAuth). When neither method is configured the
   * endpoint is left unauthenticated (local dev) and a warning is logged.
   */
  auth?: AuthOptions;
  /** Refuse to start when `auth` configures no method, instead of serving `/mcp` openly. */
  requireAuth?: boolean;
  /** Accept only loopback Host headers (DNS-rebinding protection for an open local endpoint). */
  localOnly?: boolean;
  /** Trust one reverse-proxy hop (the Cloud Foundry gorouter) for the client IP. */
  trustProxy?: boolean;
}

/** One origin as a browser sends it: scheme, host and optional port, nothing else. */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * Parse `CALM_CORS_ORIGINS` into the origins the `cors` middleware may allow. Unset means no CORS
 * headers: MCP clients call the endpoint server-side, so only browser-based clients need an entry.
 *
 * A wildcard is refused rather than honoured. Behind auth it gains nothing, and on the open local
 * endpoint (`CALM_HTTP_ALLOW_UNAUTHENTICATED`) it would let any website the developer visits call
 * 127.0.0.1 from the browser and read Cloud ALM data: without CORS headers the browser's preflight
 * blocks that. A malformed entry is refused too, so a typo cannot quietly disable a client.
 *
 * @param value - The raw environment value, a comma-separated list of origins.
 * @returns The origins, or `false` when none are configured.
 * @throws {Error} On `*` or an entry that is not `http(s)://host[:port]`.
 */
export function parseCorsOrigins(value: string | undefined): string[] | false {
  const origins = (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) return false;
  for (const origin of origins) {
    if (origin.includes('*')) {
      throw new Error(
        `CALM_CORS_ORIGINS must list exact origins; the wildcard "${origin}" is not supported. ` +
          'Name each browser client, e.g. CALM_CORS_ORIGINS=http://localhost:6274.',
      );
    }
    if (!ORIGIN.test(origin)) {
      throw new Error(
        `CALM_CORS_ORIGINS entry "${origin}" is not an origin: use scheme://host[:port] with no ` +
          'path or trailing slash, e.g. https://client.example.com.',
      );
    }
  }
  return origins;
}

/** A JSON-RPC error body for non-POST methods and failures. */
function jsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0' as const, error: { code, message }, id: null };
}

/**
 * Build the Express application exposing the MCP server over Streamable HTTP.
 *
 * @param options - HTTP app options.
 * @returns A configured Express app (call `.listen()` to start).
 */
export function createHttpApp(options: HttpAppOptions): Express {
  const { buildServer, corsOrigins, rateLimitPerMinute, logger, auth } = options;
  const app = express();

  if (options.trustProxy) {
    // Behind the gorouter every request arrives from the router's address; without this all
    // clients would share a single rate-limit bucket.
    app.set('trust proxy', 1);
  }
  if (options.localOnly) {
    app.use(localhostHostValidation());
  }
  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins,
      // Allow the MCP session header and standard auth/content headers through.
      allowedHeaders: ['Content-Type', 'mcp-session-id', 'authorization'],
      exposedHeaders: ['Mcp-Session-Id'],
    }),
  );
  // Tool arguments are small; only calm_create's document content needs more than a few KB.
  app.use(express.json({ limit: '1mb' }));
  // The OAuth token/registration endpoints accept form-encoded bodies.
  app.use(express.urlencoded({ extended: false }));
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: rateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // Cloud Foundry health check — always unauthenticated.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // MCP endpoint (stateless). One server + transport per request.
  const mcpHandler = async (req: Request, res: Response): Promise<void> => {
    const server = buildServer((req as Request & { auth?: AuthInfo }).auth);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    // Tear down per-request resources once the response is finished.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ err: (error as Error).message }, 'MCP request failed');
      if (!res.headersSent) {
        res.status(500).json(jsonRpcError(-32603, 'Internal server error'));
      }
    }
  };

  // Adapt the pino logger (obj, msg) to the auth package's structural Logger (message, data).
  const authLogger: AuthLogger = {
    debug: (msg, data) => logger.debug(data ?? {}, msg),
    info: (msg, data) => logger.info(data ?? {}, msg),
    warn: (msg, data) => logger.warn(data ?? {}, msg),
    error: (msg, data) => logger.error(data ?? {}, msg),
  };
  // Mounts any OAuth routes and returns the bearer-auth guard, or undefined when no method is set.
  const bearerAuth = setupHttpAuth(app, { ...auth, required: options.requireAuth }, authLogger);
  if (bearerAuth) {
    app.post('/mcp', bearerAuth, mcpHandler);
  } else {
    logger.warn(
      'HTTP transport is UNAUTHENTICATED (no API key or XSUAA configured). Do not expose publicly.',
    );
    app.post('/mcp', mcpHandler);
  }

  // Stateless mode does not support the server-initiated SSE stream or session deletion.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json(jsonRpcError(-32000, 'Method not allowed'));
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}
