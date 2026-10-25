// The Documents API removes `<img>` tags from a document's `content` when it returns it: the stored
// body references its images (`<img src="/…">`), the returned one has an empty paragraph in their
// place, and nothing in the response says so (docs/UPDATES.md). A model reading such a body takes
// it for the whole document, and a copy made from it with calm_create loses the images silently.
//
// calmcp cannot restore the images, but it can say they are missing: the server-side `$filter`
// still sees the stored body, so `contains(content,'<img')` tells which of the returned documents
// had images. Those get `imagesOmitted: true` and a note.

import type { CalmClients } from '../calm/index.js';
import { isGuid } from '../calm/odata.js';
import { locateRecords } from './shape.js';

/**
 * Documents checked per `$filter` request. Each adds about 48 characters (`uuid eq <uuid> or `), so
 * 50 keep the URL near 2.5 KB, well under gateway limits.
 */
const CHECK_BATCH = 50;

/**
 * Check requests in flight at once. A long list still costs a handful of requests; a few in
 * parallel stay far below Cloud ALM's 500 requests per 5 seconds, shared with every other client.
 */
const CHECK_CONCURRENCY = 3;

/** Shown on every document whose images the API left out. */
export const IMAGES_NOTE =
  'This document contains images that the Cloud ALM API does not return: `content` is ' +
  'incomplete where they were. Do not copy it into a new document or treat it as the whole ' +
  'document; open it in Cloud ALM to see the images.';

/** Shown when the check could not run, so a missing flag is never read as "no images". */
const UNCHECKED_NOTE =
  'The Cloud ALM API does not return images in document content, and calmcp could not check ' +
  'whether this document has any.';

/**
 * Flag the documents whose returned `content` lacks images the stored body has.
 *
 * Only records that came back with a `content` string without any `<img` are checked: one that
 * still carries its images needs no flag, and one without `content` has nothing to be incomplete.
 *
 * @param clients - The Cloud ALM client container.
 * @param raw - The response as the Documents API returned it (a collection or one entity).
 * @param shaped - The same response after any `fields` projection, in the same record order.
 * @returns `shaped`, with `imagesOmitted` and `imagesNote` on each affected record that kept
 *   `content`.
 */
export async function flagOmittedImages(
  clients: CalmClients,
  raw: unknown,
  shaped: unknown,
): Promise<unknown> {
  const rawRecords = locateRecords(raw)?.records ?? [];
  // An empty body has nothing to be incomplete, so it is not checked.
  const candidates = new Set(
    rawRecords.filter(
      (record) =>
        typeof record.content === 'string' &&
        record.content.length > 0 &&
        !/<img\b/i.test(record.content),
    ),
  );
  const located = locateRecords(shaped);
  // Nothing to flag when there is no candidate, or when `fields` left `content` out.
  if (!located || candidates.size === 0) return shaped;
  if (!located.records.some((record) => 'content' in record)) return shaped;

  const uuids = [...candidates].map((record) => record.uuid).filter(isGuid);
  let withImages: Set<string> | undefined;
  try {
    withImages = await documentsWithImages(clients, uuids);
  } catch {
    withImages = undefined;
  }

  return located.rebuild(
    located.records.map((record, index) => {
      const source = rawRecords[index];
      if (!source || !candidates.has(source) || !('content' in record)) return record;
      // A record without a usable uuid (e.g. `$select` left it out) cannot be checked either.
      if (withImages === undefined || !isGuid(source.uuid)) {
        return { ...record, imagesNote: UNCHECKED_NOTE };
      }
      return withImages.has(source.uuid.toLowerCase())
        ? { ...record, imagesOmitted: true, imagesNote: IMAGES_NOTE }
        : record;
    }),
  );
}

/** The uuids (lower case) among `uuids` whose stored body contains an `<img`. */
async function documentsWithImages(clients: CalmClients, uuids: string[]): Promise<Set<string>> {
  const batches: string[][] = [];
  for (let start = 0; start < uuids.length; start += CHECK_BATCH) {
    batches.push(uuids.slice(start, start + CHECK_BATCH));
  }
  const found = new Set<string>();
  const check = async (batch: string[]) => {
    const keys = batch.map((uuid) => `uuid eq ${uuid}`).join(' or ');
    const body = await clients.listOData('documents', 'Documents', {
      filter: `contains(content,'<img') and (${keys})`,
      select: 'uuid',
      top: batch.length,
    });
    for (const record of locateRecords(body)?.records ?? []) {
      if (typeof record.uuid === 'string') found.add(record.uuid.toLowerCase());
    }
  };
  // A few workers drain the queue; any failure rejects the whole check, which then says so.
  const queue = [...batches];
  const worker = async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) await check(batch);
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, batches.length) }, worker));
  return found;
}

/** Whether a get or list resource reads the Documents entity set, whose bodies lose images. */
export function returnsDocumentBodies(def: { service: string; entitySet?: string }): boolean {
  return def.service === 'documents' && def.entitySet === 'Documents';
}
