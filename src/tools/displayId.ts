// Display ids (`6-123`) for the OData entities that carry one. Tasks cannot be looked up this way:
// the Tasks REST API takes neither a display id in the path nor a filter on it.

import type { CalmClients } from '../calm/index.js';
import { isGuid, odataString } from '../calm/odata.js';
import type { ServiceName } from '../config.js';
import { LookupError } from '../errors.js';

/**
 * A display id as Cloud ALM shows it: object type number, then one or more dash-separated numbers
 * (`6-123` for a feature, `8-1-1` for a manual test case).
 */
export const DISPLAY_ID = /^\d+(?:-\d+)+$/;

/**
 * The uuid of the object with this display id (e.g. `6-123`). Two rows are fetched so that a
 * duplicate is refused, never guessed between, and only rows carrying exactly this display id
 * count: a service that ignored the filter must not hand back some other object.
 *
 * @param clients - The Cloud ALM client container.
 * @param service - The service owning the entity set.
 * @param entitySet - The OData entity set to look in.
 * @param noun - What the object is called in the error message.
 * @param displayId - The display id to resolve.
 * @returns The uuid.
 * @throws {LookupError} When no object, or more than one, carries the display id.
 */
export async function uuidByDisplayId(
  clients: CalmClients,
  service: ServiceName,
  entitySet: string,
  noun: string,
  displayId: string,
): Promise<string> {
  const page = await clients.listOData(service, entitySet, {
    filter: `displayId eq ${odataString(displayId)}`,
    select: 'uuid,displayId',
    top: 2,
  });
  const rows = (Array.isArray(page?.value) ? page.value : []) as {
    uuid?: unknown;
    displayId?: unknown;
  }[];
  if (rows.some((row) => row.displayId !== displayId)) {
    throw new LookupError(
      `Cloud ALM answered the lookup of ${noun} '${displayId}' with other objects, so calmcp ` +
        'used none of them. Pass the uuid instead.',
      'UPSTREAM_ERROR',
    );
  }
  if (rows.length === 0) {
    throw new LookupError(
      `No ${noun} has the display id '${displayId}'. Pass its uuid or display id as ` +
        'calm_get returns it.',
      'NOT_FOUND',
    );
  }
  const uuid = rows[0]?.uuid;
  if (rows.length > 1 || typeof uuid !== 'string' || !isGuid(uuid)) {
    throw new LookupError(
      `The display id '${displayId}' does not name exactly one ${noun}. Pass its uuid, as ` +
        'calm_get returns it.',
    );
  }
  return uuid;
}
