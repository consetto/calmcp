// `calm_resources` — discovery tool. Returns the catalog of resources/providers, the static code
// lists (task types/statuses/priorities), and worked recipes, so an AI client can build correct
// `calm_list` / `calm_get` / `calm_analytics` calls without guessing. Purely static; no API calls.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ANALYTICS_PROVIDERS,
  RECIPES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
} from './constants.js';
import {
  GET_RESOURCES,
  LIST_RESOURCE_NAMES,
  LIST_RESOURCES,
  type ListResource,
} from './registry.js';
import { jsonResult } from './result.js';

/** Arguments accepted by the `calm_resources` tool. */
export interface CalmResourcesArgs {
  topic?: string;
}

/** Describe one `calm_list` resource for the catalog. */
function describeListResource(name: string, def: ListResource) {
  return {
    resource: name,
    transport: def.kind,
    service: def.service,
    required: def.kind === 'rest' ? def.required : [],
    supportsOrderby: def.kind === 'odata',
    description: def.description,
  };
}

/** Build the full discovery catalog. */
function fullCatalog() {
  return {
    listResources: LIST_RESOURCE_NAMES.map((name) =>
      describeListResource(name, LIST_RESOURCES[name] as ListResource),
    ),
    getResources: Object.entries(GET_RESOURCES).map(([name, def]) => ({
      resource: name,
      transport: def.kind,
      service: def.service,
      description: def.description,
    })),
    analyticsProviders: ANALYTICS_PROVIDERS,
    codeLists: {
      taskTypes: TASK_TYPES,
      taskStatuses: TASK_STATUSES,
      taskPriorities: TASK_PRIORITIES,
    },
    recipes: RECIPES,
    hint: 'Call calm_list/calm_get with a "resource"; calm_analytics with a "provider". Pass topic="recipes" here for worked examples.',
  };
}

/**
 * Handle a `calm_resources` call.
 *
 * @param args - Validated tool arguments (optional `topic` to narrow the response).
 * @returns The catalog (or a focused subset) as a JSON tool result.
 */
export function handleCalmResources(args: CalmResourcesArgs): CallToolResult {
  const topic = args.topic?.trim();

  if (topic === 'recipes') {
    return jsonResult({ recipes: RECIPES });
  }

  if (topic) {
    // Narrow to a single resource or analytics provider when a known name is given.
    if (LIST_RESOURCES[topic]) {
      return jsonResult(describeListResource(topic, LIST_RESOURCES[topic] as ListResource));
    }
    if (GET_RESOURCES[topic]) {
      const def = GET_RESOURCES[topic];
      return jsonResult({ resource: topic, ...def, build: undefined });
    }
    if (ANALYTICS_PROVIDERS.includes(topic)) {
      return jsonResult({ provider: topic, tool: 'calm_analytics', supportsOrderby: true });
    }
    // Unknown topic — fall through to the full catalog so the caller can see valid names.
  }

  return jsonResult(fullCatalog());
}
