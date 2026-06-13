// stdio transport bootstrap. Used by local MCP clients (e.g. Claude Desktop) that launch calmcp
// as a child process and speak JSON-RPC over stdin/stdout.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Logger } from 'pino';

/**
 * Connect an MCP server to the stdio transport and begin serving.
 *
 * @param server - The MCP server to serve.
 * @param logger - Application logger (writes to stderr, never stdout).
 */
export async function startStdio(server: McpServer, logger: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('calmcp listening on stdio');
}
