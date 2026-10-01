# calmcp: guide for contributors and coding agents

calmcp is an MCP server for SAP Cloud ALM. The README describes what it does; this file describes how
to change it without breaking what models rely on.

## Principles

- **Wrong-but-plausible is the failure to avoid.** A truncated response, a silently dropped filter or
  an ignored parameter produces an answer that looks authoritative and is wrong. calmcp therefore
  rejects what it cannot honour (unknown parameters, unknown fields, `$filter` on a REST resource),
  withholds oversized payloads with a summary (`src/tools/result.ts`), and marks incomplete counts
  `complete: false`.
- **Writes are opt-in and narrow.** Read-only by default. `calm_create` only creates; there is no
  PUT and no DELETE in `src/calm/httpClient.ts`, and a write is never retried. Write payloads are
  strict schemas transcribed from the OpenAPI specs.
- **Text from Cloud ALM is untrusted.** Titles, descriptions and documents are written by other
  people and may carry instructions. Never let such text decide what calmcp writes.

## Layout

| Path | What lives there |
| --- | --- |
| `src/index.ts`, `src/server.ts` | CLI entry, transports, server assembly, instructions sent to clients, which tools a caller gets |
| `src/transport/` | stdio and Streamable HTTP (auth, CORS, rate limit) |
| `src/auth/` | OAuth2 client credentials, sandbox API key, BTP destination |
| `src/calm/` | HTTP client per Cloud ALM service, OData query building, scope hints for 403 |
| `src/tools/index.ts` | Tool registration: names, descriptions, annotations, input schemas |
| `src/tools/schemas.ts` | Tool input schemas (zod), made strict at registration |
| `src/tools/registry/` | `calm_list` and `calm_get` resources: one entry per Cloud ALM collection or entity |
| `src/tools/create.ts` | `calm_create` resources and their strict payload schemas |
| `src/tools/analyticsCatalog.ts`, `recipes.ts`, `codeLists.ts` | Static knowledge surfaced by `calm_resources` |
| `src/tools/counting.ts`, `aggregate.ts`, `paging.ts` | `count_only`, `group_by` and the paging behind them |
| `YAML/` (gitignored) | The Cloud ALM OpenAPI specs; see `docs/API_VERSIONS.md` |

## Change these together

| Task | Files |
| --- | --- |
| New `calm_list`/`calm_get` resource | `src/tools/registry/{list,get}.ts`, a test in `tests/unit/registry.test.ts`; `calm_resources` derives its catalog from the registry |
| New tool parameter | `src/tools/schemas.ts`, the handler, the tool description in `src/tools/index.ts`, `README.md`; check the size budget in `tests/unit/schema.test.ts` |
| New `calm_create` resource | `src/tools/create.ts` (schema from the spec's `*-create` body), `src/calm/scopes.ts` (write scope), README "Write access", `mcpb-manifest.json` tool description |
| New Cloud ALM service | `SERVICE_PATHS` in `src/config.ts`, `src/calm/scopes.ts`, `docs/API_VERSIONS.md`, README "Cloud ALM API scopes" |
| Server instructions or tool descriptions | Text only, but it is what models read: the tool-surface comment on the PR shows the diff and its token cost |
| Version | `npm version <x.y.z>` syncs `mcpb-manifest.json`, `mta.yaml` and `src/server.ts`; CI checks it |
| XSUAA scopes or roles | `xs-security.json` and the scope constants in `src/server.ts`; `scripts/check-xs-security.mjs` checks them in CI |

## Checks

```bash
npm run lint && npm run typecheck && npm test   # what CI runs first
npm run build && npm run test:e2e               # the built server over stdio and HTTP
npm run test:integration                        # live tenant from .env; skipped without credentials
node scripts/tool-surface.mjs snapshot dist/index.js after.json   # what models see
```

CI also validates `mta.yaml`, builds the Docker image, runs dependency review and CodeQL, and posts
the tool-surface diff on every PR. `tests/unit/schema.test.ts` keeps tool schemas within a byte budget
and within the JSON Schema subset strict hosts (Copilot Studio, Gemini) accept.

- **Test the refusal, not only the success.** For every check that refuses something, write a test
  that the refusal happens before any request is sent (MockAgent with net connect disabled), and
  confirm the test fails when the check is removed.
- **A mock is not evidence that Cloud ALM accepts something.** Behaviour the specs leave open (nulls,
  update semantics of lists, what the API strips) needs a check against a real tenant, recorded in
  the PR.

## Pull requests

- One coherent change per PR. Open it as a **draft** until it is finished and, for writes or
  changes to how calmcp talks to Cloud ALM, tested against a real tenant. Fill the template.
- Commit messages: a short plain subject, no conventional-commit prefix.
- Never commit secrets, tenant names or customer data, including in test fixtures and PR evidence.
- Check `docs/ROADMAP.md` and update it in the same PR.
- A release is `npm version <x.y.z>` plus pushing the tag; the release workflow builds and attaches
  `calmcp-<version>.mcpb`. Every GitHub release needs that bundle.
