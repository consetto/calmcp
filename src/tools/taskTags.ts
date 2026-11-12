// `calm_update` for the tags of a task: add some, remove some, keep the rest.
//
// Cloud ALM offers one call for tags, `POST /tasks/updateTags`, and it takes the target state: every
// tag missing from the payload is unassigned. A model that sent only the tag it wanted to add would
// remove all the others (docs/UPDATES.md). So the caller never sends a list. It names tags to add
// and tags to remove; calmcp reads the task, merges, and sends the whole list.
//
// What a tenant showed about that call (2026-11-11), and what this file does about it:
//   - It answers 200 and echoes the payload whatever it stored. The stored tags are therefore read
//     back, and the result reports them, not the echo.
//   - A tag that differs only in capitalisation from a tag that already exists (on this task or
//     anywhere else) is dropped without an error, and so is one longer than 256 characters. Tags
//     are matched without regard to case here, an existing tag is always sent in its stored
//     spelling, and an added tag that is missing afterwards is reported as not stored.
//   - `lastChangedTimestamp` of the task does not move when its tags change, so it cannot show that
//     someone else changed them. `expected_modified_at` is refused rather than accepted for show.
//     The merge uses the tags read just before the write, which leaves a window of milliseconds.
//   - It works the same for every task type, and a tag that does not exist yet is created.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CalmClients } from '../calm/index.js';
import { isGuid } from '../calm/odata.js';
import { describeError, UnexpectedResponseError } from '../errors.js';
import type { CalmUpdateArgs, UpdateAuditEntry } from './calmUpdate.js';
import { errorResult, errorResultFrom, jsonResult } from './result.js';
import type { Record_ } from './shape.js';
import type { TagUpdateResource } from './update.js';
import { acceptedUnreadable, outcomeUnknown } from './writeOutcome.js';

/** Tags compare without regard to case, as Cloud ALM treats them. */
const keyOf = (tag: string) => tag.toLowerCase();

/** The tags of `tags` that are not in `others`, compared by {@link keyOf}. */
function without(tags: string[], others: string[]): string[] {
  const keys = new Set(others.map(keyOf));
  return tags.filter((tag) => !keys.has(keyOf(tag)));
}

/** `tags` without repeats (by {@link keyOf}), keeping the first spelling of each. */
function distinct(tags: string[]): string[] {
  const seen = new Set<string>();
  return tags.filter((tag) => !seen.has(keyOf(tag)) && seen.add(keyOf(tag)));
}

/**
 * Read a task and its tags.
 *
 * @throws {UnexpectedResponseError} When the answer carries no tag list. Merging into an assumed
 *   empty list would unassign every tag the task has.
 */
async function readTask(
  clients: CalmClients,
  id: string,
): Promise<{ task: Record_; tags: string[] }> {
  const task = (await clients.getRest('tasks', `/tasks/${encodeURIComponent(id)}`)) as Record_;
  const tags = task?.tags;
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new UnexpectedResponseError(
      'Cloud ALM returned the task without a list of tags, so calmcp cannot tell which tags to ' +
        'keep. Nothing was sent.',
    );
  }
  return { task, tags: tags as string[] };
}

/**
 * Handle a `calm_update` call for a task's tags.
 *
 * @param clients - The Cloud ALM client container.
 * @param def - The `task_tags` resource.
 * @param args - The tool arguments.
 * @param changes - The validated changes: `add` and `remove`.
 * @param audit - Receives one entry per tag list sent to Cloud ALM.
 * @returns The tags before and after, or an error result naming what stopped the change.
 */
export async function handleTaskTags(
  clients: CalmClients,
  def: TagUpdateResource,
  args: CalmUpdateArgs,
  changes: { add?: string[]; remove?: string[] },
  audit: (entry: UpdateAuditEntry) => void,
): Promise<CallToolResult> {
  const { resource, id } = args;
  if (!isGuid(id)) {
    return errorResult(
      `${resource} needs the uuid of the task, which calm_list resource:"tasks" returns as id. ` +
        'A task cannot be looked up by its display id.',
    );
  }
  if (args.expected_modified_at !== undefined) {
    return errorResult(
      `${resource} takes no expected_modified_at: Cloud ALM does not change a task's ` +
        'lastChangedTimestamp when its tags change, so the timestamp cannot show that the tags ' +
        'were edited meanwhile. Drop it. calmcp reads the current tags right before it writes ' +
        'and changes only the ones named in add and remove.',
    );
  }
  if (args.remove_images !== undefined) {
    return errorResult(`${resource} takes no remove_images: tags hold no images. Drop it.`);
  }
  const add = distinct(changes.add ?? []);
  const remove = distinct(changes.remove ?? []);
  if (add.length === 0 && remove.length === 0) {
    return errorResult('changes is empty: name at least one tag in add or remove.');
  }
  const both = add.filter((tag) => without([tag], remove).length === 0);
  if (both.length > 0) {
    return errorResult(
      `${both.map((tag) => `"${tag}"`).join(', ')} cannot be added and removed in one call.`,
    );
  }

  let task: Record_;
  let before: string[];
  try {
    ({ task, tags: before } = await readTask(clients, id));
  } catch (error) {
    return errorResultFrom(error);
  }

  // An existing tag is always named in its stored spelling: Cloud ALM drops another capitalisation.
  const stored = (tag: string) => before.find((existing) => keyOf(existing) === keyOf(tag));
  const alreadyPresent = add.map(stored).filter((tag) => tag !== undefined);
  const added = without(add, before);
  const removed = remove.map(stored).filter((tag) => tag !== undefined);
  const notOnTask = without(remove, before);
  const noted = {
    ...(alreadyPresent.length > 0 ? { alreadyPresent } : {}),
    ...(notOnTask.length > 0 ? { notOnTask } : {}),
  };
  const identity = { resource, id, displayId: task.displayId };

  if (added.length === 0 && removed.length === 0) {
    return jsonResult({
      updated: false,
      message:
        'Nothing to change: every tag to add is already on the task and none of the tags to ' +
        'remove is. Compare the spelling with tags.',
      ...identity,
      tags: before,
      ...noted,
    });
  }

  const target = [...without(before, removed), ...added];
  const entry = { ...identity, modifiedBefore: task.lastChangedTimestamp };
  try {
    await clients.postChange(def.service, '/tasks/updateTags', { taskId: id, tags: target });
  } catch (error) {
    // A 2xx whose body could not be read was applied: carry on to the read-back below.
    if (!acceptedUnreadable(error)) {
      if (!outcomeUnknown(error)) return errorResultFrom(error);
      audit({ ...entry, outcome: 'unknown', changes: { tags: { before, after: target } } });
      const info = describeError(error);
      return errorResult(
        `${info.message}\nThe tags may or may not have been changed. Do not repeat the call ` +
          'blindly: read the task with calm_get and compare its tags first.',
        info.error,
      );
    }
  }

  // Cloud ALM accepted the list. What it stored is only known from reading the task again.
  let after: string[] | undefined;
  try {
    after = (await readTask(clients, id)).tags;
  } catch {
    after = undefined;
  }
  audit({ ...entry, outcome: 'applied', changes: { tags: { before, after: after ?? target } } });

  if (after === undefined) {
    return jsonResult({
      updated: true,
      ...identity,
      tags: { before, sent: target },
      ...noted,
      note:
        'Cloud ALM accepted the tag list, but reading the task back failed, so what it stored ' +
        'is not confirmed. Call calm_get and check tags: Cloud ALM drops some tags silently.',
    });
  }

  const notStored = without(added, after);
  const lost = without(without(before, removed), after);
  const stillThere = removed.filter((tag) => without([tag], after as string[]).length === 0);
  const problems = [
    notStored.length > 0
      ? `Cloud ALM answered 200 but did not store ${notStored.map((tag) => `"${tag}"`).join(', ')}. ` +
        'It drops a tag that differs only in capitalisation from a tag that already exists ' +
        'in Cloud ALM. Find the existing spelling with calm_list({ resource: "tasks", ' +
        `project_id: "${String(task.projectId)}", group_by: "tags" }) and add that.`
      : undefined,
    lost.length > 0
      ? `These tags were on the task, were sent again and are gone: ${lost.map((tag) => `"${tag}"`).join(', ')}. ` +
        'Tell the user, and add them again.'
      : undefined,
    stillThere.length > 0
      ? `Still on the task although removed: ${stillThere.map((tag) => `"${tag}"`).join(', ')}.`
      : undefined,
  ].filter((problem) => problem !== undefined);

  const changed = without(after, before).length > 0 || without(before, after).length > 0;
  if (!changed) {
    return errorResult(
      `The tags of the task are unchanged. ${problems.join(' ')}`.trim(),
      'UPSTREAM_ERROR',
    );
  }
  return jsonResult({
    updated: true,
    ...identity,
    tags: { before, after },
    added: without(added, notStored),
    removed: without(removed, stillThere),
    ...noted,
    ...(notStored.length > 0 ? { notStored } : {}),
    ...(lost.length > 0 ? { lost } : {}),
    ...(problems.length > 0 ? { allApplied: false, note: problems.join(' ') } : {}),
  });
}
