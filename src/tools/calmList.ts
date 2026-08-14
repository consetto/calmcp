// `calm_list` — list/query any Cloud ALM collection. The `resource` parameter selects the entity
// set or REST endpoint; OData resources accept $filter/$select/$expand/$orderby/$top/$skip, while
// REST resources accept the relevant contextual parameters (validated against the registry).
//
// Two response-shaping options are applied by calmcp itself rather than by Cloud ALM, because the
// upstream APIs do not offer them (see `tools/shape.ts` for why this matters):
//   - `timebox_id` / `timebox_name` — the Tasks REST endpoint has no timebox filter, so calmcp
//     pages through the project's tasks and selects the matching ones.
//   - `fields` — the REST endpoints ignore `$select`, so calmcp projects the records.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CalmClients } from '../calm/index.js';
import { errorMessage } from '../errors.js';
import { LIST_RESOURCES, type ListParams, type RestListResource } from './registry.js';
import { errorResult, jsonResult } from './result.js';
import {
  asRecords,
  pickTimebox,
  projectFields,
  type Record_,
  resolveTimeboxName,
  ShapeError,
} from './shape.js';

/** Arguments accepted by the `calm_list` tool (validated by `calmListShape`). */
export type CalmListArgs = ListParams & { resource: string };

/** Upstream page size used when calmcp has to page through tasks itself. */
const TASK_PAGE_SIZE = 500;

/** Safety cap on that paging: 10 pages, i.e. 5000 tasks, far above any real project. */
const MAX_TASK_PAGES = 10;

/**
 * Fetch every task matching the caller's filters, paging until the last page is short.
 *
 * Needed because the timebox filter is applied locally: filtering a single page would silently
 * miss matches on later pages.
 *
 * @param clients - The Cloud ALM client container.
 * @param def - The `tasks` resource definition.
 * @param args - Validated tool arguments.
 * @returns Every matching task record.
 * @throws {ShapeError} When the safety cap is reached, rather than truncating silently.
 */
async function fetchAllTasks(
  clients: CalmClients,
  def: RestListResource,
  args: CalmListArgs,
): Promise<Record_[]> {
  const all: Record_[] = [];

  for (let page = 0; page < MAX_TASK_PAGES; page += 1) {
    const { path, query } = def.build({
      ...args,
      limit: TASK_PAGE_SIZE,
      offset: page * TASK_PAGE_SIZE,
    });
    const rows = asRecords(await clients.getRest(def.service, path, query));
    all.push(...rows);
    if (rows.length < TASK_PAGE_SIZE) return all;
  }

  throw new ShapeError(
    `More than ${MAX_TASK_PAGES * TASK_PAGE_SIZE} tasks match before the timebox filter. ` +
      'Narrow the query first (task_type, status, assignee_id).',
  );
}

/**
 * Apply the caller's `offset`/`limit` to a locally filtered list.
 *
 * @param records - The filtered records.
 * @param offset - Records to skip, if any.
 * @param limit - Maximum records to return, if any.
 * @returns The requested window.
 */
function applyWindow(records: Record_[], offset?: number, limit?: number): Record_[] {
  const start = offset ?? 0;
  return limit === undefined ? records.slice(start) : records.slice(start, start + limit);
}

/**
 * List the tasks of a project that belong to one timebox.
 *
 * @param clients - The Cloud ALM client container.
 * @param def - The `tasks` resource definition.
 * @param args - Validated tool arguments (`timebox_id` or `timebox_name` set).
 * @returns The matching tasks.
 * @throws {ShapeError} When the timebox name cannot be resolved or the safety cap is reached.
 */
async function listTasksInTimebox(
  clients: CalmClients,
  def: RestListResource,
  args: CalmListArgs,
): Promise<Record_[]> {
  let timeboxId = args.timebox_id;

  if (timeboxId === undefined) {
    // Resolve the name against the project's timeboxes, reusing the registry's path builder.
    const timeboxDef = LIST_RESOURCES.project_timeboxes as RestListResource;
    const { path, query } = timeboxDef.build(args);
    const timeboxes = await clients.getRest(timeboxDef.service, path, query);
    timeboxId = resolveTimeboxName(timeboxes, args.timebox_name as string);
  }

  const matching = pickTimebox(await fetchAllTasks(clients, def, args), timeboxId);
  return applyWindow(matching, args.offset, args.limit);
}

/**
 * Handle a `calm_list` call.
 *
 * @param clients - The Cloud ALM client container.
 * @param args - Validated tool arguments.
 * @returns The collection as a JSON tool result, or an error result.
 */
export async function handleCalmList(
  clients: CalmClients,
  args: CalmListArgs,
): Promise<CallToolResult> {
  const def = LIST_RESOURCES[args.resource];
  if (!def) {
    return errorResult(
      `Unknown resource '${args.resource}'. Use calm_resources to list valid ones.`,
    );
  }

  if (args.timebox_id !== undefined && args.timebox_name !== undefined) {
    return errorResult('Pass either timebox_id or timebox_name, not both.');
  }
  const byTimebox = args.timebox_id !== undefined || args.timebox_name !== undefined;
  if (byTimebox && args.resource !== 'tasks') {
    return errorResult("timebox_id/timebox_name apply to resource 'tasks' only.");
  }

  try {
    let data: unknown;

    if (def.kind === 'odata') {
      data = await clients.listOData(def.service, def.entitySet, {
        filter: args.filter,
        select: args.select,
        expand: args.expand,
        orderby: args.orderby,
        top: args.top,
        skip: args.skip,
      });
    } else {
      // REST resource: enforce required contextual parameters before issuing the request.
      const missing = def.required.filter((name) => !args[name as keyof ListParams]);
      if (missing.length > 0) {
        return errorResult(
          `Missing required parameter(s) for resource '${args.resource}': ${missing.join(', ')}`,
        );
      }

      if (byTimebox) {
        data = await listTasksInTimebox(clients, def, args);
      } else {
        const { path, query } = def.build(args);
        data = await clients.getRest(def.service, path, query);
      }
    }

    return jsonResult(args.fields ? projectFields(data, args.fields) : data);
  } catch (error) {
    if (error instanceof ShapeError) return errorResult(error.message);
    return errorResult(errorMessage(error));
  }
}
