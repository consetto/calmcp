// `calm_resources` — discovery tool. Returns the catalog of resources/providers, the static code
// lists (task types/statuses/priorities), and worked recipes, so an AI client can build correct
// `calm_list` / `calm_get` / `calm_analytics` calls without guessing. Purely static; no API calls.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  ANALYTICS_PROVIDER_FIELDS,
  ANALYTICS_PROVIDERS,
  RECIPES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_SUB_STATUSES,
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

/**
 * One-line steer that applies to every question, placed where a client looking for *anything*
 * will read it. Counting by listing is the single most expensive mistake a caller can make here.
 */
const COUNTING_HINT =
  'For any "how many ...?" question pass count_only:true, and for "... broken down by X" pass ' +
  'group_by:"X" — to calm_analytics for a tenant-wide snapshot, or to calm_list for a live, ' +
  'project-scoped count. Both return a few hundred bytes. Listing records to count them returns ' +
  'hundreds of KB and gets truncated. group_by also enumerates the values a field actually takes.';

/** Describe one `calm_list` resource for the catalog. */
function describeListResource(name: string, def: ListResource) {
  return {
    resource: name,
    transport: def.kind,
    service: def.service,
    required: def.kind === 'rest' ? def.required : [],
    supportsOrderby: def.kind === 'odata',
    // Both forms are exact; only the cost differs, so the caller can judge when to narrow first.
    countMethod:
      def.kind === 'odata'
        ? 'server-side $count, one request'
        : 'calmcp pages through the collection (up to 20000 records)',
    description: def.description,
  };
}

/** Describe one analytics provider, including its field catalogue when one is transcribed. */
function describeProvider(name: string) {
  const fields = ANALYTICS_PROVIDER_FIELDS[name];
  return {
    provider: name,
    tool: 'calm_analytics',
    supportsOrderby: true,
    scope: 'tenant-wide; no project_id needed',
    freshness: 'daily snapshot, so counts may differ from a live calm_list read',
    countExample: `calm_analytics({ provider: '${name}', count_only: true })`,
    breakdownExample: `calm_analytics({ provider: '${name}', group_by: 'status' })`,
    ...(fields ?? {
      fieldsUnknown:
        'Field list not transcribed from the spec for this provider. Use group_by:"<field>" to ' +
        'discover the values a field takes, and check the response keys for the field names.',
    }),
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
    analyticsProviderFields: ANALYTICS_PROVIDER_FIELDS,
    countingHint: COUNTING_HINT,
    codeLists: {
      taskTypes: TASK_TYPES,
      taskStatuses: TASK_STATUSES,
      taskSubStatuses: TASK_SUB_STATUSES,
      taskPriorities: TASK_PRIORITIES,
    },
    recipes: RECIPES,
    hint:
      'Call calm_list/calm_get with a "resource"; calm_analytics with a "provider". Pass ' +
      'topic="recipes" here for worked examples, or a provider name for its dimensions and ' +
      'measures.',
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
    return jsonResult({ recipes: RECIPES, countingHint: COUNTING_HINT });
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
      return jsonResult(describeProvider(topic));
    }
    // Unknown topic — fall through to the full catalog so the caller can see valid names.
  }

  return jsonResult(fullCatalog());
}
