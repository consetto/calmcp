// `calm_update` — change fields of an existing SAP Cloud ALM object. Registered only when the operator
// enabled it (`CALM_UPDATE_ENABLED=true`) and, over HTTP, only for callers with the Writer scope.
//
// An update can lose what a create cannot, so every call goes through the same checks, in order
// (docs/UPDATES.md):
//   1. the changes are validated against the resource's allowlist; an unknown field is an error;
//   2. the object is read again, and the call is refused when it changed since the caller read it:
//      Cloud ALM offers no ETag/If-Match, so this is the only protection against overwriting an
//      edit someone made in the UI in the meantime;
//   3. fields that already hold the requested value are dropped, so nothing unintended is sent;
//   4. a rich-text change that would drop an image is refused unless the caller says so;
//   5. only the remaining fields are sent, with PATCH;
//   6. the object is read back, and the result shows each changed field before and after.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { CalmClients } from '../calm/index.js';
import { errorResult, errorResultFrom, jsonResult } from './result.js';
import type { calmUpdateShape } from './schemas.js';
import type { Record_ } from './shape.js';
import { droppedImages, imageKeys, UPDATE_RESOURCES, type UpdateResource } from './update.js';

/** Arguments accepted by the `calm_update` tool. */
export type CalmUpdateArgs = z.infer<z.ZodObject<typeof calmUpdateShape>>;

/** One record of the audit trail, written for every update that reached Cloud ALM. */
export interface UpdateAuditEntry {
  resource: string;
  id: string;
  displayId?: unknown;
  fields: string[];
  /** The modification timestamp before and after, to find the change in Cloud ALM's history. */
  modifiedBefore: unknown;
  modifiedAfter: unknown;
}

/** Accepts the keys Cloud ALM issues, so a display id is told apart before any request. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Handle a `calm_update` call.
 *
 * @param clients - The Cloud ALM client container.
 * @param args - Validated tool arguments.
 * @param audit - Receives one entry per update sent to Cloud ALM, for the operator's log.
 * @returns What changed as a JSON tool result, or an error result naming what stopped the update.
 */
export async function handleCalmUpdate(
  clients: CalmClients,
  args: CalmUpdateArgs,
  audit: (entry: UpdateAuditEntry) => void = () => {},
): Promise<CallToolResult> {
  // The tool is not registered without the switch; this guards a stale client holding its name.
  if (!clients.updateEnabled) {
    return errorResult(
      'Update access is disabled: calmcp changes existing objects only when ' +
        'CALM_UPDATE_ENABLED=true is set.',
    );
  }
  const def = UPDATE_RESOURCES[args.resource];
  if (!def) {
    return errorResult(
      `Unknown resource '${args.resource}'. Use calm_resources to list what calm_update accepts.`,
    );
  }
  if (!GUID.test(args.id)) {
    return errorResult(
      `'${args.id}' is not a uuid. calm_update takes the uuid; calm_get({ resource: ` +
        `'${args.resource}', id: '${args.id}' }) returns it together with ${def.modifiedField}.`,
    );
  }

  const parsed = def.schema.safeParse(args.changes);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.length > 0 ? issue.path.join('.') : 'changes'}: ${issue.message}`,
    );
    return errorResult(
      `Invalid changes for resource '${args.resource}':\n- ${problems.join('\n- ')}\n` +
        `Call calm_resources({ topic: '${args.resource}' }) for the fields calm_update accepts.`,
    );
  }
  const requested = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
  if (requested.length === 0) {
    return errorResult('changes is empty: name at least one field to change.');
  }

  try {
    const current = (await clients.getOData(def.service, def.entitySet, args.id)) as Record_;

    const modifiedBefore = current[def.modifiedField];
    if (modifiedBefore !== args.expected_modified_at) {
      return errorResult(
        `The ${args.resource} changed since it was read: ${def.modifiedField} is now ` +
          `${JSON.stringify(modifiedBefore)}, the call expected ` +
          `${JSON.stringify(args.expected_modified_at)}. Read it again with calm_get, apply the ` +
          'change to the current values, and pass the new timestamp.',
        'CONFLICT',
      );
    }

    const changes = Object.fromEntries(
      requested.filter(([field, value]) => !sameValue(current[field], value)),
    );
    const fields = Object.keys(changes);
    if (fields.length === 0) {
      return jsonResult({
        updated: false,
        message: 'Nothing to change: every field already holds the requested value.',
        uuid: args.id,
        displayId: current.displayId,
        [def.modifiedField]: modifiedBefore,
      });
    }

    const blocked = imageProblems(def, current, changes);
    if (blocked && args.allow_image_removal !== true) return errorResult(blocked);

    await clients.updateOData(def.service, def.entitySet, args.id, changes);
    const after = (await clients.getOData(def.service, def.entitySet, args.id)) as Record_;
    audit({
      resource: args.resource,
      id: args.id,
      displayId: current.displayId,
      fields,
      modifiedBefore,
      modifiedAfter: after[def.modifiedField],
    });

    return jsonResult({
      updated: true,
      resource: args.resource,
      uuid: args.id,
      displayId: after.displayId,
      [def.modifiedField]: after[def.modifiedField],
      changes: Object.fromEntries(
        fields.map((field) => [
          field,
          describeChange(def, field, current[field], after[field], changes[field]),
        ]),
      ),
    });
  } catch (error) {
    return errorResultFrom(error);
  }
}

/** Equal as JSON values; Cloud ALM returns the same scalars it accepts. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** Why a rich-text change is refused, or undefined when it keeps every image. */
function imageProblems(
  def: UpdateResource,
  current: Record_,
  changes: Record<string, unknown>,
): string | undefined {
  const problems = def.richTextFields
    .filter((field) => field in changes)
    .map((field) => ({ field, dropped: droppedImages(current[field], changes[field]) }))
    .filter(({ dropped }) => dropped.length > 0);
  if (problems.length === 0) return undefined;
  const list = problems.map(
    ({ field, dropped }) => `${field}: ${dropped.length} image(s) (${dropped.join(', ')})`,
  );
  return (
    `The change would remove images:\n- ${list.join('\n- ')}\n` +
    "Images are <img> tags referencing Cloud ALM's image service; keep each tag, unchanged, " +
    'wherever it belongs in the new text. If removing them is intended, confirm with the user ' +
    'and call again with allow_image_removal: true.'
  );
}

/** One changed field for the result. A rich-text field is summarised, not echoed twice. */
function describeChange(
  def: UpdateResource,
  field: string,
  before: unknown,
  after: unknown,
  sent: unknown,
): Record<string, unknown> {
  // Cloud ALM may normalise what it stores (whitespace, entities); say so rather than hide it.
  const stored = sameValue(after, sent) ? {} : { storedDiffersFromSent: true };
  if (!def.richTextFields.includes(field)) return { before, after, ...stored };
  const size = (value: unknown) => (typeof value === 'string' ? value.length : 0);
  return {
    before: { length: size(before), images: imageKeys(before).length },
    after: { length: size(after), images: imageKeys(after).length },
    ...stored,
  };
}
