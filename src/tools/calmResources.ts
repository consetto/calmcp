// `calm_resources` — discovery tool. Returns the catalog of resources/providers, the static code
// lists (task types/statuses/priorities), worked recipes, and (when write access is on) the
// payload fields of every `calm_create` resource, so an AI client can build correct calls without
// guessing. Purely static; no API calls.

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
import { CREATE_RESOURCES, type CreateResource, describeObject } from './create.js';
import {
  GET_RESOURCES,
  LIST_RESOURCE_NAMES,
  LIST_RESOURCES,
  type ListResource,
  odataParams,
  readParams,
} from './registry.js';
import { jsonResult } from './result.js';

/** Arguments accepted by the `calm_resources` tool. */
export interface CalmResourcesArgs {
  topic?: string;
}

/** Deployment facts the catalog depends on. */
export interface CalmResourcesOptions {
  /** Whether `calm_create` is registered (`CALM_WRITE_ENABLED`). */
  writeEnabled: boolean;
}

/** What the catalog says about creating when the operator left calmcp read-only. */
const WRITE_DISABLED_NOTE =
  'Write access is off: this deployment is read-only and offers no calm_create tool. An operator ' +
  'can enable create-only access for documents and library entries with CALM_WRITE_ENABLED=true.';

/** Describe one `calm_create` resource with the fields its payload accepts. */
function describeCreateResource(name: string, def: CreateResource) {
  return {
    resource: name,
    tool: 'calm_create',
    service: def.service,
    entitySet: def.entitySet,
    description: def.description,
    fields: describeObject(def.schema),
    example: `calm_create({ resource: '${name}', data: { title: '...'${
      name === 'document' ? ", projectId: '<project uuid>'" : ''
    } } })`,
  };
}

/** The `createResources` section of the catalog. */
function createSection(options: CalmResourcesOptions) {
  if (!options.writeEnabled) {
    return { enabled: false, note: WRITE_DISABLED_NOTE };
  }
  return {
    enabled: true,
    note:
      'calm_create only creates. It never updates or deletes, so check with calm_list first ' +
      'whether an equivalent entry already exists.',
    resources: Object.entries(CREATE_RESOURCES).map(([name, def]) =>
      describeCreateResource(name, def),
    ),
  };
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
  // Everything else is rejected by calm_list, so this is the complete list a caller can narrow by.
  const parameters = def.kind === 'rest' ? readParams(def) : odataParams();
  return {
    resource: name,
    transport: def.kind,
    service: def.service,
    required: def.kind === 'rest' ? def.required : [],
    parameters,
    supportsFilter: parameters.includes('filter'),
    supportsOrderby: parameters.includes('orderby'),
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
    // Verified on a tenant: the service accepts $orderby, ignores it, and returns 200 even for a
    // field that does not exist. Sorting must happen in the caller.
    supportsOrderby: false,
    scope: 'tenant-wide; no project_id needed',
    freshness: 'daily snapshot, so counts may differ from a live calm_list read',
    countExample: `calm_analytics({ provider: '${name}', count_only: true })`,
    breakdownExample: `calm_analytics({ provider: '${name}', group_by: '${statusField(name)}' })`,
    ...(fields ?? {
      fieldsUnknown:
        'Field list not transcribed from the spec for this provider. Use group_by:"<field>" to ' +
        'discover the values a field takes, and check the response keys for the field names.',
    }),
  };
}

/**
 * The field a status breakdown groups by for a provider. Not always `status`: Defects calls it
 * `defectStatus`, and an example naming a missing field sends the caller into an error.
 */
function statusField(provider: string): string {
  const fields = ANALYTICS_PROVIDER_FIELDS[provider];
  if (!fields) return 'status';
  const known = [...fields.filterable, ...fields.dimensions];
  return known.find((field) => /status$/i.test(field) && field !== 'statusText') ?? 'status';
}

/** Build the full discovery catalog. */
function fullCatalog(options: CalmResourcesOptions) {
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
    createResources: createSection(options),
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
 * @param options - Deployment facts; defaults to the read-only deployment.
 * @returns The catalog (or a focused subset) as a JSON tool result.
 */
export function handleCalmResources(
  args: CalmResourcesArgs,
  options: CalmResourcesOptions = { writeEnabled: false },
): CallToolResult {
  const topic = args.topic?.trim();

  if (topic === 'recipes') {
    return jsonResult({ recipes: RECIPES, countingHint: COUNTING_HINT });
  }

  if (topic) {
    // Narrow to a single resource or analytics provider when a known name is given.
    // Own-property lookups only: a free-text topic such as "constructor" must not reach the
    // object prototype.
    if (Object.hasOwn(LIST_RESOURCES, topic)) {
      return jsonResult(describeListResource(topic, LIST_RESOURCES[topic] as ListResource));
    }
    // `document` and the xlib names are both a calm_get and a calm_create resource: describe the
    // read side as before and add the create payload when the tool is actually offered.
    const get = Object.hasOwn(GET_RESOURCES, topic) ? GET_RESOURCES[topic] : undefined;
    const create =
      options.writeEnabled && Object.hasOwn(CREATE_RESOURCES, topic)
        ? CREATE_RESOURCES[topic]
        : undefined;
    if (get || create) {
      return jsonResult({
        resource: topic,
        ...(get ? { ...get, build: undefined } : {}),
        ...(create ? { create: describeCreateResource(topic, create) } : {}),
      });
    }
    if (ANALYTICS_PROVIDERS.includes(topic)) {
      return jsonResult(describeProvider(topic));
    }
    // Unknown topic — fall through to the full catalog so the caller can see valid names.
  }

  return jsonResult(fullCatalog(options));
}
