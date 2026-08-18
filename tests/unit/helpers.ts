// Shared harness for the tool tests: a stub auth provider plus a `CalmClients` wired to a fixed
// origin, so `undici`'s MockAgent can intercept every request by URL.

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
 * @returns The clients under test.
 */
export function makeClients(): CalmClients {
  const config = new Config({
    sandbox: false,
    tenant: 'acme',
    region: 'eu10',
    clientId: 'id',
    clientSecret: 'secret',
    debug: false,
    timeoutSeconds: 30,
    tokenRefreshBufferSeconds: 5,
  });
  return new CalmClients(new StubAuth(), config, createLogger(false));
}

/**
 * Parse the JSON text block from a tool result.
 *
 * @param result - The tool result.
 * @returns The parsed payload.
 */
export function parse(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0]?.text ?? 'null');
}
