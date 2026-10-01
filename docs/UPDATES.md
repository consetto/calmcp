# Updating Cloud ALM objects: analysis

Can calmcp offer updates to existing objects, and what could a read-modify-write lose? calmcp is
create-only today (see the README, "Write access"). This analysis looks at what the Cloud ALM APIs
allow, where rich text and images live, and what a safe update tool would need.

Sources: the OpenAPI specs of the 19 Cloud ALM APIs (pulled 2026-09-21), SAP's *API Guide for SAP
Cloud ALM* (generated 2026-09-29), and read-only checks against a real tenant on 2026-09-30.

## Status

Implemented on this basis:

- **`imagesOmitted`**: `calm_get` and `calm_list` flag every document whose returned `content` lacks
  images its stored body has, using a `contains(content,'<img')` check (see "Suggested first step").
- **Feature create**: `calm_create` accepts `feature`.
- **`calm_update` for features**, behind `CALM_UPDATE_ENABLED`, with every point of "What a safe
  update tool would need" below: PATCH of only the changed fields, a field allowlist, the image
  guard, the change check against `modifiedAt`, no target-state endpoints, documents excluded, an
  audit log, and the Writer scope on HTTP. Tasks and the other objects are not covered yet.
- **After review:** rich text written by `calm_create` and `calm_update` is refused when it carries
  active content (scripts, event handlers, `javascript:`/`data:` URLs, CSS `url(...)`) or images
  from outside Cloud ALM's image service; image removal names the images (`remove_images`) instead
  of a blanket switch; an update Cloud ALM accepted is reported and audited even when reading it
  back fails, and one without an answer is audited as `outcome: unknown`; the audit entry holds the
  replaced values; `null` clears assignments.

## Summary

- **Documents cannot be updated.** The API has no way to change a document's title or HTML body.
  The risk of losing images by writing a document back therefore does not exist, because there is
  no write-back.
- **Reading a document already loses its images.** The Documents API removes `<img>` tags from
  `content` when returning it. A document copied via `calm_create` from what was read would arrive
  without its images, silently. This affects calmcp today, not only a future update tool.
- **Most other objects can be updated with `PATCH`**, which changes only the fields sent. Several
  have writable descriptions that hold HTML, and features were found to carry images in theirs.
- **Features return their images intact**, as references to Cloud ALM's image service. A
  read-modify-write keeps them as long as the tags survive the edit; an AI rewriting the text can
  easily drop them.
- **No API offers optimistic locking.** Every update is last-write-wins.

An update tool is feasible for objects with `PATCH`, if it guards rich-text fields and never sends
a field the caller did not mean to change. Documents stay out of scope.

## What each API allows

| API | Update | Delete | Rich text fields writable by update |
| --- | --- | --- | --- |
| Documents (`CALM_SD`) | `PUT /Documents/{uuid}`: only `fileContent` (external file) and sub-entities | yes | none: `content` and `title` are not updatable |
| Tasks (`CALM_TKM`) | `PATCH /tasks/{id}`, comments, references, workstreams, deliverables | yes | task `description`, comment `text`, deliverable `description` |
| Features (`CALM_CDM_ODATA`) | `PATCH /Features/{uuid}` | links only | `description` |
| Test management (`CALM_TM`, `CALM_TM_PLAN`) | `PATCH` on test cases, activities, actions, test plans | yes | action and test plan `description` |
| Process hierarchy (`CALM_PH`) | `PATCH /HierarchyNodes/{uuid}` | yes | `description` (2500) |
| Process management (`CALM_PM`) | `PATCH /scopes/{id}` | yes | `description` (2500) |
| Process authoring (`CALM_PMGE`) | `PATCH` on processes, flows, activities, diagrams | yes | `description` (5000), diagram `svg` |
| Projects (`CALM_PJM`) | `PATCH` on projects, programs, timeboxes, teams, system groups | some | program `description` |
| Cross-library (`CALM_XLIB_*`) | `PATCH` on applications, configurations, activities, developments, interfaces | yes | `description` |
| Analytics, status events, test automation, IAM | none | none | n/a |

The Documents spec says: "Update an existing document is supported only for attribute
'fileContent' via PUT request". The API guide is firmer: "The API does not support an
update/change possibility of existing documents. Sub-entities such as URLReferences or
SolutionProcessAssignments can be logically changed by a delete operation and a subsequent create
operation." Tags are set with `POST /updateTags`, which takes the **target state**: a tag missing
from the payload is unassigned.

## Images

### Documents: stripped on read

In the test tenant 3 of 80 documents contain `<img`. All three reference their images by a
relative path (`<img src="/…">`); none embeds them as `data:` URIs.

For document 7-52 the server-side filter `contains(content,'<span><img src="/')` matches, and
`contains(content,'<p><span></span></p>')` does not. The `content` the API returns is the
opposite: no `<img>` at all, and `<p><span></span></p>` exactly where the images are. The API
removes the image tags when it serializes the body. calmcp does not alter successful responses
(it strips HTML only from error bodies), so this is Cloud ALM's behaviour.

Consequences:

- A document body read through the API is incomplete whenever the document has images, and
  nothing in the response says so.
- `calm_create` with a body taken from an existing document creates a copy without images.
- Even if SAP allowed document updates, a read-modify-write through this API would delete every
  image. That matches the concern that prompted this analysis.

### Features: returned intact

In the same tenant 76 of 297 features have an HTML description and 4 contain `<img`. For feature
6-132 the API returns all nine image tags, in the form

```html
<img src="/ui/imageServiceAPI/v1/getImage?imageId=4e4b35c0-4a3e-405c-9695-e64b6a9f3166" alt="sfw5_select" />
```

The image is stored in the image service; the description holds only a reference. Sending the same
HTML back keeps the images. They are lost when the new text omits or alters a tag, which is what an
AI does when asked to "shorten the description" or "fix the wording". The API would accept it
without complaint.

Not verified: whether task, test and process descriptions can hold images (the Tasks REST API has
no server-side filter to check cheaply), and whether the image service deletes an image once no
object references it.

## Other risks of an update tool

- **Last write wins.** No update API supports `If-Match`/ETag. If someone edits the object in the
  UI between the model's read and its write, that edit is overwritten.
- **Target-state endpoints.** `updateTags` (documents, tasks) unassigns every tag not in the
  payload. A model that sends only the tag it wants to add removes all others.
- **Fields the caller did not mean to change.** A `PATCH` built from a full read sends every field
  back; any the model misread, or any Cloud ALM normalises differently on read and write, changes.
- **Status transitions** may have rules the UI enforces and the API does not, or reject them with
  errors a model misreads.
- **Scopes.** Updates need the `*.write` scopes (e.g. `calm-api.tasks.write`,
  `calm-api.features.write`) on the Cloud ALM API service instance, and calmcp's `Writer` role.

## What a safe update tool would need

1. **`PATCH` only, never `PUT`,** and only the fields named in the call. The tool takes
   `{ resource, id, changes }`, not a full object.
2. **A field allowlist per resource**, transcribed from the `*-update` schemas like `calm_create`
   does today; an unknown field is an error.
3. **An image guard for rich-text fields.** Before sending a new `description`, read the current
   one and collect the `imageId`s (and any other `<img src>`). If the new value drops any, refuse
   unless the call names exactly those images in `remove_images`. The error lists their keys.
4. **A change check instead of optimistic locking.** The call carries the `modifiedAt` (or
   `lastChangedTimestamp`) the model read. The tool re-reads the object and refuses if it changed
   since. This narrows the race window to milliseconds; it cannot close it.
5. **No target-state endpoints** (`updateTags`) at first, or only with an explicit add/remove
   interface that reads the current tags and sends the merged set.
6. **Documents excluded,** and the document read path marked: when a `content` comes from the
   Documents API, add a note that images are not included, so neither the model nor a user treats
   it as the complete document.
7. **An audit log** of every update with caller, object, fields and old values, since Cloud ALM
   records only the technical user.
8. **Opt-in like `calm_create`:** a separate operator switch (e.g. `CALM_UPDATE_ENABLED`) and the
   `Writer` scope on HTTP, off by default.

## Suggested first step

Independent of any update tool, and cheap: make the document read path honest. When a document's
`content` is returned, calmcp cannot see the stripped images, but it can check the server side with
`contains(content,'<img')` for that document and add
`"imagesOmitted": true` with a note that the body is incomplete. That protects the existing
`calm_create` copy scenario today.

A first update tool could then start with **features and tasks**, the two objects people edit most,
with the guards above, and be tested against a sandbox project before anything else.
