// Update registry: the resources `calm_update` can change, each with the strict schema of the fields
// a caller may change, transcribed from the `*-update` request bodies of the OpenAPI specs.
//
// Deliberately narrow (see docs/UPDATES.md). Only objects whose API updates with PATCH, and only
// plain fields: no project moves, no type changes, no link or assignment lists, whose update
// semantics (add or replace) the specs do not state. Documents are absent because the Documents API
// cannot change a document's title or body at all.

import { z } from 'zod';
import type { ServiceName } from '../config.js';
import { featureEditableFields } from './create.js';

/** A `calm_update` resource: one OData entity set plus the fields a caller may change. */
export interface UpdateResource {
  service: ServiceName;
  entitySet: string;
  /** Strict schema of the changes; every field optional, unknown ones rejected. */
  schema: z.ZodObject<z.ZodRawShape>;
  /**
   * HTML fields whose images are guarded: a change that would drop an `<img>` is refused unless
   * the caller says the removal is intended.
   */
  richTextFields: string[];
  /** The field that changes on every save, compared against what the caller read. */
  modifiedField: string;
  description: string;
}

/** Fields of a feature that `calm_update` may change. */
export const featureUpdateSchema = z
  .object({
    title: featureEditableFields.title.optional(),
    description: featureEditableFields.description.optional(),
    scopeId: featureEditableFields.scopeId.optional(),
    statusCode: featureEditableFields.statusCode.optional(),
    priorityCode: featureEditableFields.priorityCode.optional(),
    responsibleId: featureEditableFields.responsibleId.optional(),
    releaseId: featureEditableFields.releaseId.optional(),
    workstreamId: featureEditableFields.workstreamId.optional(),
  })
  .strict();

/** Resources changeable via `calm_update`, keyed by the public `resource` value. */
export const UPDATE_RESOURCES: Record<string, UpdateResource> = {
  feature: {
    service: 'features',
    entitySet: 'Features',
    schema: featureUpdateSchema,
    richTextFields: ['description'],
    modifiedField: 'modifiedAt',
    description:
      'Change fields of an existing feature: title, HTML description, status, priority, scope, ' +
      'responsible, release, workstream',
  },
};

/** Public `resource` values accepted by `calm_update`. */
export const UPDATE_RESOURCE_NAMES = Object.keys(UPDATE_RESOURCES);

/**
 * The images an HTML value references, one key per image.
 *
 * Cloud ALM stores an image in its image service and puts `<img src="/ui/imageServiceAPI/v1/
 * getImage?imageId=<uuid>">` into the HTML; the image id is the key, so a tag rewritten with other
 * attributes still counts as the same image. Any other `<img>` is keyed by its `src`.
 *
 * @param html - An HTML string (or anything else, which has no images).
 * @returns The image keys, in order of appearance, without duplicates.
 */
export function imageKeys(html: unknown): string[] {
  if (typeof html !== 'string') return [];
  const keys: string[] = [];
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = (src?.[1] ?? src?.[2] ?? src?.[3] ?? '').replace(/&amp;/g, '&');
    const imageId = /[?&]imageId=([^&#]+)/i.exec(value)?.[1];
    const key = imageId ? `imageId:${decodeURIComponent(imageId).toLowerCase()}` : `src:${value}`;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * The images `current` references that `next` no longer does.
 *
 * @param current - The stored HTML.
 * @param next - The HTML the caller wants to store instead.
 * @returns The keys of the images the change would remove.
 */
export function droppedImages(current: unknown, next: unknown): string[] {
  const kept = new Set(imageKeys(next));
  return imageKeys(current).filter((key) => !kept.has(key));
}
