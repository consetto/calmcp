// Streamable HTTP transport. Exposes the MCP server over HTTP for remote clients and for SAP BTP
// Cloud Foundry deployment. Hardened with helmet, CORS and rate limiting, and provides a `/health`
// endpoint for the Cloud Foundry health check.
//
// The server runs in stateless mode: each POST /mcp builds a fresh MCP server (reusing the shared
// Cloud ALM clients) and a single-shot transport. This keeps horizontal scaling on BTP simple.
//
// When `auth` is supplied (XSUAA bound on BTP), `/mcp` requires a valid bearer token carrying the
// read scope, and the MCP-native OAuth proxy (RFC 8414 discovery + RFC 7591 DCR delegated to XSUAA)
// is mounted so clients like Claude Desktop authenticate automatically. Without `auth`, `/mcp` is
// open (local development) and a warning is logged.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { mountXsuaaAuth, type XsuaaCredentials } from '../httpAuth/index.js';

/** Options for the HTTP app. */
export interface HttpAppOptions {
  /** Factory creating a fresh MCP server per request (clients are shared/captured by the factory). */
  buildServer: () => McpServer;
  /** Allowed CORS origins (`'*'`, a single origin, or a list). */
  corsOrigins: string | string[];
  /** Max requests per minute per client (rate limit). */
  rateLimitPerMinute: number;
  /** Application logger. */
  logger: Logger;
  /**
   * When present, protect `/mcp` with XSUAA bearer auth and mount the MCP-native OAuth proxy.
   * Omit (local dev) to leave `/mcp` unauthenticated.
   */
  auth?: { credentials: XsuaaCredentials; appUrl: string };
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

  app.use(helmet());
  app.use(
    cors({
      origin: corsOrigins,
      // Allow the MCP session header and standard auth/content headers through.
      allowedHeaders: ['Content-Type', 'mcp-session-id', 'authorization'],
      exposedHeaders: ['Mcp-Session-Id'],
    }),
  );
  app.use(express.json({ limit: '4mb' }));
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
    const server = buildServer();
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

  if (auth) {
    // Mounts the OAuth router (/authorize, /token, /register, /revoke + discovery) and the callback,
    // and returns the bearer-auth guard for /mcp.
    const bearerAuth = mountXsuaaAuth(app, auth.credentials, auth.appUrl, logger);
    app.post('/mcp', bearerAuth, mcpHandler);
  } else {
    logger.warn(
      'HTTP transport is UNAUTHENTICATED — no XSUAA service bound. Do not expose publicly.',
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
