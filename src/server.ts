// MCP server assembly: builds the shared Cloud ALM client container and an `McpServer` with the
// four read tools registered, plus `calm_create` when write access is enabled. The client
// container is created once (so token caches persist); a fresh `McpServer` can be built per HTTP
// request while reusing those clients.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { createAuthProvider } from './auth/index.js';
import { CalmClients } from './calm/index.js';
import type { Config } from './config.js';
import { registerTools } from './tools/index.js';
import { configureResults } from './tools/result.js';

/** Server name advertised to MCP clients. */
const SERVER_NAME = 'calmcp';
/** Server version advertised to MCP clients. */
const SERVER_VERSION = '0.9.0';

/** Instructions shown to MCP clients on connect (read-only deployment). */
const INSTRUCTIONS =
  'Read-only access to SAP Cloud ALM (tasks/defects, projects, features, documents, test ' +
  'management, process hierarchy, analytics, status events, landscape, cross-library). Start with ' +
  'calm_resources to discover resources, providers and worked recipes. Use calm_list/calm_get for ' +
  'entities and calm_analytics for sorted/aggregated queries (e.g. open defects ordered by ' +
  'priority). Never answer "how many ...?" by listing records and counting them: pass ' +
  'count_only:true for a total, or group_by:"<field>" for a breakdown. Both return a few hundred ' +
  'bytes instead of hundreds of KB. calm_analytics counts tenant-wide, calm_list counts live ' +
  'within a project.';

/** Extra instructions when the operator enabled `calm_create`. */
const WRITE_INSTRUCTIONS =
  ' Write access is enabled for creating only: calm_create adds a new document or a new library ' +
  'entry (cross-library application, configuration, configuration activity, development, ' +
  'interface). Nothing is ever updated or deleted. Before creating, check with calm_list ' +
  'whether an equivalent entry already exists, and confirm the target project with the user.';

/**
 * Create the shared Cloud ALM client container for the current configuration.
 *
 * @param config - Validated configuration.
 * @param logger - Application logger.
 * @returns A {@link CalmClients} container wired to the selected auth provider.
 */
export function createClients(config: Config, logger: Logger): CalmClients {
  // Both transports build their clients here, so this is the one place the response budget is
  // guaranteed to be applied before any tool can produce a result.
  configureResults({ maxBytes: config.maxResponseBytes });
  const auth = createAuthProvider(config, logger);
  return new CalmClients(auth, config, logger);
}

/**
 * Build an MCP server instance with the tools registered.
 *
 * @param clients - The shared Cloud ALM client container (its `writeEnabled` flag decides whether
 *   `calm_create` is offered).
 * @param logger - Application logger.
 * @returns A configured {@link McpServer}.
 */
export function buildMcpServer(clients: CalmClients, logger: Logger): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: clients.writeEnabled ? INSTRUCTIONS + WRITE_INSTRUCTIONS : INSTRUCTIONS },
  );
  registerTools(server, clients, logger);
  return server;
}
