// Update registry: the resources `calm_update` can change, each with the strict schema of the fields
// a caller may change, transcribed from the `*-update` request bodies of the OpenAPI specs.
//
// Deliberately narrow (see docs/UPDATES.md). Only objects whose API updates with PATCH, and only
// plain fields: no project moves, no type changes, no link or assignment lists, whose update
// semantics (add or replace) the specs do not state. The one list calmcp does change is a task's
// tags, whose semantics are known (the whole list is replaced) and wrapped in add and remove. Documents are absent because the Documents API
// cannot change a document's title or body at all.

import { z } from 'zod';
import type { ServiceName } from '../config.js';
import { featureEditableFields } from './create.js';

/** A `calm_update` resource: one OData entity set plus the fields a caller may change. */
export interface UpdateResource {
  kind: 'patch';
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

/**
 * A `calm_update` resource that adds and removes the tags of an object. Cloud ALM only takes the
 * whole tag list (`POST /tasks/updateTags`: a tag missing from the payload is unassigned), so
 * calmcp reads the current tags and sends the merged list; see `taskTags.ts`.
 */
export interface TagUpdateResource {
  kind: 'tags';
  service: ServiceName;
  /** Strict schema of the changes: `add` and `remove`. */
  schema: z.ZodObject<z.ZodRawShape>;
  description: string;
}

/** Longest tag Cloud ALM stores; a longer one is dropped without an error (tenant, 2026-11-11). */
export const MAX_TAG_LENGTH = 256;

/**
 * One tag, e.g. `Release: Wave 2`. Angle brackets and control characters are refused: a tag is a
 * label, Cloud ALM stores it as sent, and calmcp writes no markup it has not checked.
 */
const tag = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TAG_LENGTH)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
  .refine((value) => !/[<>\u0000-\u001f\u007f]/.test(value), {
    message: 'a tag may not contain < or > or control characters',
  });

/** Tags to add to and remove from a task. */
const taskTagsSchema = z
  .object({
    add: z
      .array(tag)
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Tags to add, e.g. ["Release: Wave 2"]. A tag that does not exist yet is created. Use the ' +
          'exact spelling of an existing tag: Cloud ALM drops one that differs only in capitalisation',
      ),
    remove: z
      .array(tag)
      .min(1)
      .max(50)
      .optional()
      .describe('Tags to take off the task. Every other tag stays'),
  })
  .strict();

/** Fields of a feature that `calm_update` may change. */
const featureUpdateSchema = z
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
export const UPDATE_RESOURCES: Record<string, UpdateResource | TagUpdateResource> = {
  feature: {
    kind: 'patch',
    service: 'features',
    entitySet: 'Features',
    schema: featureUpdateSchema,
    richTextFields: ['description'],
    modifiedField: 'modifiedAt',
    description:
      'Change fields of an existing feature: title, HTML description, status, priority, scope, ' +
      'responsible, release, workstream',
  },
  task_tags: {
    kind: 'tags',
    service: 'tasks',
    schema: taskTagsSchema,
    description:
      'Add tags to and remove tags from an existing task of any type (project task, user story, ' +
      'defect, requirement, sub-task, risk). The other tags of the task stay as they are',
  },
};

/** Public `resource` values accepted by `calm_update`. */
export const UPDATE_RESOURCE_NAMES = Object.keys(UPDATE_RESOURCES);
