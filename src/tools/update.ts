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
    statusCode: featureEditableFields.statusCode.optional(),
    priorityCode: featureEditableFields.priorityCode.optional(),
    // Assignments can be removed: null clears them. Not yet verified against a tenant that the
    // Features API accepts null for each of them.
    scopeId: clearable(featureEditableFields.scopeId),
    responsibleId: clearable(featureEditableFields.responsibleId),
    releaseId: clearable(featureEditableFields.releaseId),
    workstreamId: clearable(featureEditableFields.workstreamId),
  })
  .strict();

/** An optional field that `null` clears, with the description saying so. */
function clearable<T extends z.ZodType>(field: T) {
  return field
    .nullable()
    .optional()
    .describe(`${field.description ?? ''}. null removes it`);
}

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
