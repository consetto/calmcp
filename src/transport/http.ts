// Streamable HTTP transport. Exposes the MCP server over HTTP for remote clients and for SAP BTP
// Cloud Foundry deployment. Hardened with helmet, CORS and rate limiting, and provides a `/health`
// endpoint for the Cloud Foundry health check.
//
// The server runs in stateless mode: each POST /mcp builds a fresh MCP server (reusing the shared
// Cloud ALM clients) and a single-shot transport. This keeps horizontal scaling on BTP simple.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import express, { type Express, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import type { Logger } from 'pino';

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
  const { buildServer, corsOrigins, rateLimitPerMinute, logger } = options;
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
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: rateLimitPerMinute,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // Cloud Foundry health check.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // MCP endpoint (stateless). One server + transport per request.
  app.post('/mcp', async (req: Request, res: Response) => {
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
  });

  // Stateless mode does not support the server-initiated SSE stream or session deletion.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json(jsonRpcError(-32000, 'Method not allowed'));
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  return app;
}
