// MCP server assembly: builds the shared Cloud ALM client container and an `McpServer` with the
// four read-only tools registered. The client container is created once (so token caches persist);
// a fresh `McpServer` can be built per HTTP request while reusing those clients.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { createAuthProvider } from './auth/index.js';
import { CalmClients } from './calm/index.js';
import type { Config } from './config.js';
import { registerTools } from './tools/index.js';

/** Server name advertised to MCP clients. */
const SERVER_NAME = 'calmcp';
/** Server version advertised to MCP clients. */
const SERVER_VERSION = '0.1.0';

/** Instructions shown to MCP clients on connect. */
const INSTRUCTIONS =
  'Read-only access to SAP Cloud ALM (tasks/defects, projects, features, documents, test ' +
  'management, process hierarchy, analytics, status events, landscape, cross-library). Start with ' +
  'calm_resources to discover resources, providers and worked recipes. Use calm_list/calm_get for ' +
  'entities and calm_analytics for sorted/aggregated queries (e.g. open defects ordered by priority).';

/**
 * Create the shared Cloud ALM client container for the current configuration.
 *
 * @param config - Validated configuration.
 * @param logger - Application logger.
 * @returns A {@link CalmClients} container wired to the selected auth provider.
 */
export function createClients(config: Config, logger: Logger): CalmClients {
  const auth = createAuthProvider(config, logger);
  return new CalmClients(auth, config, logger);
}

/**
 * Build an MCP server instance with the read-only tools registered.
 *
 * @param clients - The shared Cloud ALM client container.
 * @param logger - Application logger.
 * @returns A configured {@link McpServer}.
 */
export function buildMcpServer(clients: CalmClients, logger: Logger): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, clients, logger);
  return server;
}
