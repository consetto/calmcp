# Changelog

calmcp follows [semantic versioning](https://semver.org) from 1.0 on; the README section
"Versioning and stability" says what counts as the public interface. Releases before 1.0 are
described on the [GitHub releases page](https://github.com/consetto/calmcp/releases).

## 1.0.0

The first stable release. It settles the parameter names before semver locks them, adds links
between existing objects, and hardens how calmcp reads from Cloud ALM and how it reports writes.

### Breaking changes

| 0.9 | 1.0 | Note |
| --- | --- | --- |
| `limit`, `offset` (REST resources) | `top`, `skip` | One paging pair for every resource; calmcp translates it for each service. `nextPage` is always `{ skip }`. |
| `filters` | `rest_filters` | Query parameters of `landscape_objects`, `landscape_access_control_lists`, `bsm_events`. |
| `count` | `with_count` | Total alongside the records; `count_only` is unchanged. |

A call with an old name is refused before anything is sent, and the message names the new one
("'limit' is now 'top'").

Other changes a client may notice:

- `calm_create` and `calm_update` called with the write switch off answer `CONFIG` instead of
  `INVALID_ARGUMENT` (#59).
- Rich text is checked against an allowlist of elements, attributes and URL schemes instead of a
  blocklist, so HTML outside it is refused (#55). HTML from the Cloud ALM editor passes.
- A create or update that times out or gets a 408 or 5xx answers `retryable: false` and says it may
  or may not have been applied; the audit entry carries `outcome: "unknown"` (#54).
- A REST list without `top` asks for 500 records and announces a full page with `nextPage`; before,
  the service's own default (100 for landscape objects) came back with no hint of more.
- `top`, `skip`, `select` and `with_count` next to `count_only`/`group_by`, and paging keys inside
  `rest_filters`, are refused instead of ignored.
- An id that is neither a uuid nor a display id is refused before any lookup.
- Tool results are compact JSON (no indentation), about a third smaller.
- A Cloud ALM page that is neither an array, `{ value }` nor `{ Resources }` is `UPSTREAM_ERROR`
  instead of being read as empty (#58). A Cloud ALM answer over 8 MB is `RESPONSE_TOO_LARGE` (#57).

### Features

- **Links between existing objects** in `calm_create`: `task_feature_link`, `task_document_link`,
  `task_process_link`, `task_relation`, `task_reference`, `feature_url_reference`,
  `test_case_task_link`. Features, documents, process nodes and manual test cases can be named by
  display id. Needs `calm-api.testcases.write` for test case links (#53).
- **Transports of features**: `feature_transports` and `feature_transport_references` (#51).
- **One display-id lookup** for `calm_get` (features), `calm_create` and `calm_update`, which
  refuses an answer for another object (#56). Three-part display ids such as `8-1-1` (manual test
  cases) are accepted in `calm_create` links.
- **Counts stop after 40 seconds** with `complete: false` and `stoppedBy: "time"` instead of running
  into the client's timeout (#58). The budget also cuts off a page still in flight, and covers
  analytics breakdowns and the timebox walk.
- **`calm_analytics` gives `nextPage`** for a full page, like `calm_list`.
- **Analytics providers that need a filter** (`ServiceLevels`, `MonitoringEvents`) say so in
  `calm_resources` as `requires`.
- **403 hints** name the analytics provider scopes, the operations scopes and the scope for
  landscape access control lists.

### Fixes

- Counting `ConfigurationItems` no longer sends a `resolution`, which that provider does not have.
- `group_by` no longer refuses a field that is missing from the first page but present on later
  ones (Cloud ALM leaves empty attributes out); on OData resources it fetches only the grouped
  fields.
- A page holding a null entry no longer ends paging early; the dropped-filter check of analytics
  counts uses the caller's own time window.
- A burst of 401s no longer discards a freshly fetched token, and BTP destination mode fetches a
  new token after a 401.
- Document lists skip the image lookup when the result is too large to hand over anyway.
- The integration test for the next-page hint no longer fails on an empty tenant (#60).

### Security and operations

- Rich text: named entities in `style`, `href` and `src` (`&sol;`, `&colon;`, `&bsol;`, ...) are
  refused, and numeric ones decoded before the check, so a host or CSS escape cannot hide behind
  them. The tag scanner runs in linear time (crafted input took seconds before).
- OAuth: dynamic client registration and the built-in client accept only the redirect URIs of
  known MCP clients (`CALM_OAUTH_REDIRECT_PATTERNS` adds more); before, any `https://` redirect and
  any app on `*.hana.ondemand.com`.
- CI: actions pinned by commit, no persisted git credentials, and the release token only on the
  upload step.
- HTTP hardening: bodies are streamed with an 8 MB cap, a 401 is retried once with a fresh token,
  token fetches are single-flight and validated, and errors on `/mcp` are JSON-RPC errors without
  stack traces (#57).
- `.cfignore`, a new `.dockerignore`, `.gitignore` and the `mta.yaml` ignore list keep local notes,
  scripts, assistant settings and old archives out of every package (#60).
- follow-redirects advisory GHSA-mrwp-f3q8-3g9p fixed by a lockfile update (#60).

### Documentation

- README: the full set of Cloud ALM API scopes as instance JSON, the operations scopes, the
  versioning promise, and a known Cloud ALM limitation: a feature description that contains images
  cannot be changed through the API (Cloud ALM's image service refuses the technical user).
- `SECURITY.md`, this changelog, specs of 2026-10-08 and a reworked roadmap (#52).

### Upgrading from 0.9

- Rename `limit`/`offset` to `top`/`skip`, `filters` to `rest_filters`, `count` to `with_count` in
  saved prompts, recipes or Copilot Studio actions.
- For test case links, add `calm-api.testcases.write` to the Cloud ALM API instance.
- Nothing changes in XSUAA or the destination. If an MCP client other than Claude, ChatGPT, Cursor,
  VS Code, Mistral, Copilot Studio or a localhost callback signs in over OAuth, add its redirect URI
  with `CALM_OAUTH_REDIRECT_PATTERNS`.
