// Shared harness for the tool tests: a stub auth provider plus a `CalmClients` wired to a fixed
// origin, so `undici`'s MockAgent can intercept every request by URL.

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AuthContext, AuthProvider } from '../../src/auth/index.js';
import { CalmClients } from '../../src/calm/index.js';
import { Config } from '../../src/config.js';
import { createLogger } from '../../src/logging.js';

/** Origin every intercepted request is expected on. */
export const ORIGIN = 'https://acme.eu10.alm.cloud.sap';

export class StubAuth implements AuthProvider {
  async authorize(): Promise<AuthContext> {
    return { baseUrl: `${ORIGIN}/api`, headers: { Authorization: 'Bearer t' } };
  }
}

/**
 * Build a client container pointing at {@link ORIGIN}.
 *
 * @param options - `writeEnabled` turns on the create primitive and `updateEnabled` the update
 *   primitive (both default off, like production).
 * @returns The clients under test.
 */
export function makeClients(
  options: { writeEnabled?: boolean; updateEnabled?: boolean } = {},
): CalmClients {
  const config = new Config({
    sandbox: false,
    tenant: 'acme',
    region: 'eu10',
    clientId: 'id',
    clientSecret: 'secret',
    debug: false,
    timeoutSeconds: 30,
    tokenRefreshBufferSeconds: 5,
    writeEnabled: options.writeEnabled,
    updateEnabled: options.updateEnabled,
  });
  return new CalmClients(new StubAuth(), config, createLogger(false));
}

/**
 * The text of a tool result's first content block. A tool result's content may also hold images,
 * audio or resources; every calmcp tool answers with text, so anything else fails the test here
 * rather than as an undefined further down.
 *
 * @param result - The tool result.
 * @returns The text of its first block.
 */
export function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== 'text') {
    throw new Error(`expected a text block, got ${block?.type ?? 'no content'}`);
  }
  return block.text;
}

/**
 * Parse the JSON text block from a tool result.
 *
 * @param result - The tool result.
 * @returns The parsed payload.
 */
export function parse(result: CallToolResult): unknown {
  return JSON.parse(textOf(result));
}
