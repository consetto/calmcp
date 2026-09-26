// Resource registry: the single source of truth mapping each `calm_list` / `calm_get` resource to
// a concrete Cloud ALM request. Keeping this declarative lets the four MCP tools stay generic and
// makes the supported resources (and their required parameters) discoverable via `calm_resources`.
//
// The entries live under `registry/`: `list.ts` and `get.ts` hold the resources, `probe.ts` works
// out which parameters a resource reads, and `types.ts` the shapes they share.

export * from './registry/get.js';
export * from './registry/list.js';
export * from './registry/probe.js';
export * from './registry/types.js';
