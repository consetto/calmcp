// Which OAuth redirect URIs calmcp's XSUAA proxy accepts from MCP clients.

/**
 * Where an MCP client may receive its OAuth authorization code: the clients calmcp is used with.
 * The package default also admits any `https://` URI through dynamic client registration and any
 * app on `*.hana.ondemand.com` for the built-in client, so a link to someone else's app could
 * carry a signed-in user's code there once they approve the consent page. Extend with
 * CALM_OAUTH_REDIRECT_PATTERNS (comma-separated globs) for another client.
 */
export const CLIENT_REDIRECT_PATTERNS = [
  'http://localhost:*/**',
  'http://127.0.0.1:*/**',
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://callback.mistral.ai/v1/integrations_auth/oauth2_callback',
  'https://global.consent.azure-apim.net/redirect/**',
  'cursor://anysphere.cursor-retrieval/**',
  'cursor://anysphere.cursor-mcp/**',
  'vscode://vscode.microsoft-authentication/**',
  'vscode-insiders://vscode.microsoft-authentication/**',
];

/**
 * The redirect patterns of this deployment: the known clients plus the operator's own.
 *
 * @param env - The environment, read for CALM_OAUTH_REDIRECT_PATTERNS.
 * @returns The globs for both the built-in client and dynamic client registration.
 */
export function redirectPatterns(env: NodeJS.ProcessEnv): string[] {
  const extra = (env.CALM_OAUTH_REDIRECT_PATTERNS ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  return [...CLIENT_REDIRECT_PATTERNS, ...extra];
}
