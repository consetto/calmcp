// Registers the four read-only MCP tools on an `McpServer`, wiring each to its handler and the
// shared Cloud ALM client container. Tool calls and (truncated) results are traced via the logger.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import type { CalmClients } from '../calm/index.js';
import { logToolCall, logToolResult } from '../logging.js';
import { type CalmAnalyticsArgs, handleCalmAnalytics } from './calmAnalytics.js';
import { type CalmGetArgs, handleCalmGet } from './calmGet.js';
import { type CalmListArgs, handleCalmList } from './calmList.js';
import { type CalmResourcesArgs, handleCalmResources } from './calmResources.js';
import { calmAnalyticsShape, calmGetShape, calmListShape, calmResourcesShape } from './schemas.js';

/**
 * Register all calmcp tools on the given MCP server.
 *
 * @param server - The MCP server to register tools on.
 * @param clients - The Cloud ALM client container handlers call into.
 * @param logger - Application logger.
 */
export function registerTools(server: McpServer, clients: CalmClients, logger: Logger): void {
  // Wrap a handler with call/result tracing so every tool gets consistent debug logging.
  const traced =
    <A>(tool: string, handler: (a: A) => CallToolResult | Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      logToolCall(logger, tool, args);
      const result = await handler(args);
      logToolResult(logger, tool, result);
      return result;
    };

  server.registerTool(
    'calm_list',
    {
      title: 'List SAP Cloud ALM data',
      description:
        'List or query any SAP Cloud ALM collection (tasks, projects, features, documents, test ' +
        'cases, hierarchy nodes, cross-library objects, landscape objects, status events, code ' +
        'lists). Choose a "resource"; OData resources accept $filter/$select/$expand/$orderby/' +
        '$top/$skip, REST resources accept contextual params. Defects: resource="tasks", ' +
        'task_type="CALMDEF". See calm_resources for the full catalog.',
      inputSchema: calmListShape,
    },
    traced('calm_list', (args: CalmListArgs) => handleCalmList(clients, args)),
  );

  server.registerTool(
    'calm_get',
    {
      title: 'Get one SAP Cloud ALM entity',
      description:
        'Fetch a single SAP Cloud ALM entity by id (a feature can also be fetched by display id ' +
        'like "6-123"). Choose a "resource" and pass its "id". See calm_resources for valid ones.',
      inputSchema: calmGetShape,
    },
    traced('calm_get', (args: CalmGetArgs) => handleCalmGet(clients, args)),
  );

  server.registerTool(
    'calm_analytics',
    {
      title: 'Query SAP Cloud ALM analytics',
      description:
        'Query an SAP Cloud ALM analytics provider (Defects, Tasks, Tests, Features, Projects, ' +
        'Metrics, ...). Supports $filter and $orderby — use this for sorted/aggregated questions ' +
        'such as "open defects ordered by priority".',
      inputSchema: calmAnalyticsShape,
    },
    traced('calm_analytics', (args: CalmAnalyticsArgs) => handleCalmAnalytics(clients, args)),
  );

  server.registerTool(
    'calm_resources',
    {
      title: 'Discover SAP Cloud ALM resources',
      description:
        'Discovery helper: lists every resource/provider the other tools accept, their required ' +
        'parameters, the task type/status/priority code lists, and worked recipes. Pass ' +
        'topic="recipes" for multi-step examples, or a resource/provider name to focus.',
      inputSchema: calmResourcesShape,
    },
    traced('calm_resources', (args: CalmResourcesArgs) => handleCalmResources(args)),
  );
}
