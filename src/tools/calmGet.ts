// `calm_get` — fetch a single Cloud ALM entity by id across domains. OData entities are fetched by
// key; features additionally accept a display id (e.g. "6-123"), resolved via a `displayId` filter.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { CalmClients } from '../calm/index.js';
import { isGuid, odataString } from '../calm/odata.js';
import { flagOmittedImages, returnsDocumentBodies } from './documentImages.js';
import { GET_RESOURCES } from './registry.js';
import { errorResult, errorResultFrom, jsonResult } from './result.js';
import type { calmGetShape } from './schemas.js';
import { projectFields } from './shape.js';

/** Arguments accepted by the `calm_get` tool. */
export type CalmGetArgs = z.infer<z.ZodObject<typeof calmGetShape>>;

/** Retry advice when one entity is over the response budget. */
const GET_OVERSIZE_HINT =
  'Re-run calm_get with fields:"<comma-separated names>" picked from availableFields, e.g. the ' +
  'header fields first and a long description only if it is really needed. Drop expand if set.';

/**
 * Handle a `calm_get` call.
 *
 * @param clients - The Cloud ALM client container.
 * @param args - Validated tool arguments.
 * @returns The entity as a JSON tool result, or an error result.
 */
export async function handleCalmGet(
  clients: CalmClients,
  args: CalmGetArgs,
): Promise<CallToolResult> {
  const def = GET_RESOURCES[args.resource];
  if (!def) {
    return errorResult(
      `Unknown resource '${args.resource}'. Use calm_resources to list valid ones.`,
    );
  }
  // The REST endpoints take no $expand. Fetching without it would silently omit what was asked for.
  if (def.kind === 'rest' && args.expand !== undefined) {
    return errorResult(
      `Resource '${args.resource}' is a REST endpoint and does not read expand. Drop it: the ` +
        'entity comes back with the fields the endpoint always returns.',
    );
  }

  // A single task carries ~70 fields and HTML descriptions; `fields` keeps just the ones needed.
  // A document body comes back without its images, so it is flagged when it had any.
  const respond = async (entity: unknown) => {
    const shaped = args.fields ? projectFields(entity, args.fields) : entity;
    return jsonResult(
      returnsDocumentBodies(def) ? await flagOmittedImages(clients, entity, shaped) : shaped,
      GET_OVERSIZE_HINT,
    );
  };

  try {
    if (def.kind === 'rest') {
      return await respond(await clients.getRest(def.service, def.build(args.id)));
    }

    // OData entity: resolve a feature display id to its uuid when the id is not a UUID.
    if (def.allowDisplayId && !isGuid(args.id)) {
      const collection = await clients.listOData(def.service, def.entitySet, {
        filter: `displayId eq ${odataString(args.id)}`,
        top: 1,
      });
      const first = collection.value[0] as { uuid?: string } | undefined;
      if (!first) {
        return errorResult(`No ${args.resource} found with display id '${args.id}'`, 'NOT_FOUND');
      }
      // If an expand was requested, re-fetch by uuid to include the navigations.
      if (args.expand && first.uuid) {
        return await respond(
          await clients.getOData(def.service, def.entitySet, first.uuid, args.expand),
        );
      }
      return await respond(first);
    }

    return await respond(await clients.getOData(def.service, def.entitySet, args.id, args.expand));
  } catch (error) {
    return errorResultFrom(error);
  }
}
