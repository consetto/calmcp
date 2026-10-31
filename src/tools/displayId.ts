// Display ids (`6-132`) for the OData entities that carry one. Tasks cannot be looked up this way:
// the Tasks REST API takes neither a display id in the path nor a filter on it.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CalmClients } from '../calm/index.js';
import { isGuid, odataString } from '../calm/odata.js';
import type { ServiceName } from '../config.js';
import { errorResult } from './result.js';

/** A display id as Cloud ALM shows it: object type number, dash, sequence number. */
export const DISPLAY_ID = /^\d+-\d+$/;

/**
 * The uuid of the object with this display id (e.g. `6-132`), or an error result when no object or
 * more than one carries it. Two are fetched so that a duplicate is refused, never guessed between.
 *
 * @param clients - The Cloud ALM client container.
 * @param service - The service owning the entity set.
 * @param entitySet - The OData entity set to look in.
 * @param noun - What the object is called in the error message.
 * @param displayId - The display id to resolve.
 * @returns The uuid, or an error result.
 */
export async function uuidByDisplayId(
  clients: CalmClients,
  service: ServiceName,
  entitySet: string,
  noun: string,
  displayId: string,
): Promise<string | CallToolResult> {
  const { value } = await clients.listOData(service, entitySet, {
    filter: `displayId eq ${odataString(displayId)}`,
    select: 'uuid,displayId',
    top: 2,
  });
  const uuids = (value as { uuid?: unknown }[]).map((row) => row.uuid);
  if (uuids.length === 0) {
    return errorResult(
      `No ${noun} has the display id '${displayId}'. Pass its uuid or display id as ` +
        'calm_get returns it.',
      'NOT_FOUND',
    );
  }
  const [uuid] = uuids;
  if (uuids.length > 1 || typeof uuid !== 'string' || !isGuid(uuid)) {
    return errorResult(
      `The display id '${displayId}' does not name exactly one ${noun}. Pass its uuid, as ` +
        'calm_get returns it.',
    );
  }
  return uuid;
}
