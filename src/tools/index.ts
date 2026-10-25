// Registers the MCP tools on an `McpServer`, wiring each to its handler and the shared Cloud ALM
// client container. The four read tools are always present; `calm_create` and `calm_update` are
// registered only when the caller may use them (operator switch plus, over HTTP, the Writer scope). Tool calls and (truncated) results are traced via the logger.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { CalmClients } from '../calm/index.js';
import { runWithContext } from '../context.js';
import { logToolCall, logToolResult } from '../logging.js';
import { type CalmAnalyticsArgs, handleCalmAnalytics } from './calmAnalytics.js';
import { type CalmCreateArgs, handleCalmCreate } from './calmCreate.js';
import { type CalmGetArgs, handleCalmGet } from './calmGet.js';
import { type CalmListArgs, handleCalmList } from './calmList.js';
import { type CalmResourcesArgs, handleCalmResources } from './calmResources.js';
import { type CalmUpdateArgs, handleCalmUpdate } from './calmUpdate.js';
import {
  calmAnalyticsShape,
  calmCreateShape,
  calmGetShape,
  calmListShape,
  calmResourcesShape,
  calmUpdateShape,
} from './schemas.js';

/**
 * A tool's input schema as a strict object. Zod 4 no longer advertises `additionalProperties: false`
 * for a plain object, and a parameter the model invented (`projectId` for `project_id`) would be
 * dropped without a word. Strict says so in the schema and rejects the call, naming the key.
 */
function strictInput<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

/** Hints for the tools that read Cloud ALM: clients may run them without asking. */
const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: true };
/** `calm_resources` answers from static catalogue data and never calls Cloud ALM. */
const DISCOVERY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** Which write tools one caller gets, decided by `buildMcpServer`. */
export interface ToolAccess {
  /** Offer `calm_create`. */
  write: boolean;
  /** Offer `calm_update`. */
  update: boolean;
  /** Who is calling, for the audit log of updates (user, client id, or "local"). */
  caller?: string;
}

/**
 * Register all calmcp tools on the given MCP server.
 *
 * @param server - The MCP server to register tools on.
 * @param clients - The Cloud ALM client container handlers call into.
 * @param logger - Application logger.
 * @param access - The write tools this caller gets; see `buildMcpServer`.
 */
export function registerTools(
  server: McpServer,
  clients: CalmClients,
  logger: Logger,
  access: ToolAccess = { write: clients.writeEnabled, update: clients.updateEnabled },
): void {
  // Wrap a handler with call/result tracing so every tool gets consistent debug logging.
  // Each call also runs with its abort signal in context, so Cloud ALM requests stop when the client
  // cancels the call.
  const traced =
    <A>(tool: string, handler: (a: A) => CallToolResult | Promise<CallToolResult>) =>
    async (args: A, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      logToolCall(logger, tool, args);
      const result = await runWithContext({ signal: extra.signal }, () => handler(args));
      logToolResult(logger, tool, result);
      return result;
    };

  server.registerTool(
    'calm_list',
    {
      title: 'List SAP Cloud ALM data',
      annotations: READ_ONLY,
      description:
        'List or query any SAP Cloud ALM collection (tasks, projects, features, documents, test ' +
        'cases, hierarchy nodes, cross-library objects, landscape objects, status events, code ' +
        'lists). Choose a "resource"; OData resources accept $filter/$select/$expand/$orderby/' +
        '$top/$skip; REST resources read only the params calm_resources lists for them, and ' +
        'any other param (including $filter) is rejected rather than ignored. Defects: ' +
        'resource="tasks", task_type="CALMDEF". To answer "how many?" pass count_only=true, or ' +
        'group_by="status" for a breakdown — never list records to count them, as a few hundred ' +
        'tasks overflow most clients. See calm_resources for the full catalog.',
      inputSchema: strictInput(calmListShape),
    },
    traced('calm_list', (args: CalmListArgs) => handleCalmList(clients, args)),
  );

  server.registerTool(
    'calm_get',
    {
      title: 'Get one SAP Cloud ALM entity',
      annotations: READ_ONLY,
      description:
        'Fetch a single SAP Cloud ALM entity by id (a feature can also be fetched by display id ' +
        'like "6-123"). Choose a "resource" and pass its "id". See calm_resources for valid ones. ' +
        'A task has ~70 fields: pass fields="displayId,title,status,..." to keep the answer small.',
      inputSchema: strictInput(calmGetShape),
    },
    traced('calm_get', (args: CalmGetArgs) => handleCalmGet(clients, args)),
  );

  server.registerTool(
    'calm_analytics',
    {
      title: 'Query SAP Cloud ALM analytics',
      annotations: READ_ONLY,
      description:
        'Query an SAP Cloud ALM analytics provider (Defects, Tasks, Tests, Features, Projects, ' +
        'Metrics, ...). Supports $filter, and aggregates: it is the tool for tenant-wide totals ' +
        'and breakdowns. It does NOT sort — $orderby is ignored, so sort the records yourself. ' +
        'Every provider spans the whole tenant, so ' +
        'this is how you count without naming a project: count_only=true for a total, ' +
        'group_by="status" for a breakdown (Defects: "defectStatus"). Tasks covers user ' +
        'stories, defects and requirements; filter them by type CODE, e.g. ' +
        'filter="typeID eq \'CALMUS\'" (the type text is silently ignored).',
      inputSchema: strictInput(calmAnalyticsShape),
    },
    traced('calm_analytics', (args: CalmAnalyticsArgs) => handleCalmAnalytics(clients, args)),
  );

  server.registerTool(
    'calm_resources',
    {
      title: 'Discover SAP Cloud ALM resources',
      annotations: DISCOVERY,
      description:
        'Discovery helper: lists every resource/provider the other tools accept, their required ' +
        'parameters, the task type/status/priority code lists, and worked recipes. Pass ' +
        'topic="recipes" for multi-step examples, or a resource/provider name to focus.' +
        (access.write
          ? ' Also lists what calm_create accepts, with the fields of each payload.'
          : '') +
        (access.update ? ' Also lists the fields calm_update may change.' : ''),
      inputSchema: strictInput(calmResourcesShape),
    },
    traced('calm_resources', (args: CalmResourcesArgs) =>
      handleCalmResources(args, { writeEnabled: access.write, updateEnabled: access.update }),
    ),
  );

  if (access.write) registerCreate(server, clients, traced);
  if (access.update) registerUpdate(server, clients, logger, traced, access.caller);
}

/** The tracing wrapper `registerTools` applies to every handler. */
type Traced = <A>(
  tool: string,
  handler: (a: A) => CallToolResult | Promise<CallToolResult>,
) => (args: A, extra: { signal: AbortSignal }) => Promise<CallToolResult>;

/** Register `calm_create`. */
function registerCreate(server: McpServer, clients: CalmClients, traced: Traced): void {
  server.registerTool(
    'calm_create',
    {
      title: 'Create a SAP Cloud ALM document, feature or library entry',
      // Adds a record but never overwrites one; a repeat call creates a second entry.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      description:
        'Create a NEW SAP Cloud ALM document, feature, or library entry (cross-library ' +
        'application, configuration, configuration activity, development or interface). It never ' +
        'changes or deletes an existing object, so calling it twice makes two entries. ' +
        'Pass "resource" and a "data" object; calm_resources({ topic: "<resource>" }) lists the ' +
        'fields. Links and assignments can be included in "data" and are created with the entity. ' +
        'Returns the created entity including its uuid and displayId.',
      inputSchema: strictInput(calmCreateShape),
    },
    traced('calm_create', (args: CalmCreateArgs) => handleCalmCreate(clients, args)),
  );
}

/** Register `calm_update`, with every update written to the audit log. */
function registerUpdate(
  server: McpServer,
  clients: CalmClients,
  logger: Logger,
  traced: Traced,
  caller = 'unknown',
): void {
  server.registerTool(
    'calm_update',
    {
      title: 'Change fields of a SAP Cloud ALM feature',
      // Changes an existing record; repeating the same change leaves it as it is.
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      description:
        'Change fields of an EXISTING SAP Cloud ALM feature (title, HTML description, status, ' +
        'priority, scope, responsible, release, workstream). First read it with calm_get and ' +
        'pass its uuid and modifiedAt as expected_modified_at; the update is refused if it ' +
        'changed since. Send only the fields to change in "changes"; null clears scope, ' +
        'responsible, release or workstream. A description change that drops an image (<img> ' +
        "tag) is refused unless remove_images names it, which needs the user's confirmation; " +
        'scripts, event handlers and foreign images are always refused. Confirm every change ' +
        'with the user before calling. Returns each changed field before and after.',
      inputSchema: strictInput(calmUpdateShape),
    },
    traced('calm_update', (args: CalmUpdateArgs) =>
      handleCalmUpdate(clients, args, (entry) =>
        // Cloud ALM records only calmcp's technical user, so this log is where the person is.
        logger.info({ audit: 'calm_update', caller, ...entry }, 'Cloud ALM object updated'),
      ),
    ),
  );
}
