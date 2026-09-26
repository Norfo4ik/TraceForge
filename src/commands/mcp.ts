import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRepoTools, getRepoRoot } from "../core/repoTools.js";
import { ToolRegistry } from "../core/toolRegistry.js";

export interface McpServeOptions {
  /** Repository to serve; defaults to the git repository containing the current directory. */
  repo?: string;
}

/**
 * Serves this tool's read-only repository tools (list/read/grep files, git log/diff) as an MCP server over
 * stdio, so any MCP client — VS Code, GitHub Copilot, Claude — can use them on this repo. Together with the
 * Azure DevOps server this CLI consumes, that makes it both an MCP client and an MCP server.
 *
 * stdout carries the JSON-RPC protocol here, so nothing may write to it: diagnostics go to stderr only.
 */
export async function runMcpServer(opts: McpServeOptions = {}): Promise<void> {
  if (opts.repo) process.chdir(opts.repo);
  const repoRoot = getRepoRoot();

  const registry = new ToolRegistry();
  registry.registerAll(createRepoTools(repoRoot));

  const server = new Server({ name: "traceforge-repo", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.definitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as { type: "object"; properties?: Record<string, unknown> },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const text = await registry.execute(request.params.name, JSON.stringify(request.params.arguments ?? {}));
    return { content: [{ type: "text" as const, text }], isError: text.startsWith('{"error":') };
  });

  await server.connect(new StdioServerTransport());
  console.error(`[traceforge] repo tools MCP server ready for ${repoRoot} (${registry.size} read-only tools)`);
}
