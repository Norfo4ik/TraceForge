import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolHandler } from "./toolRegistry.js";
import { logger } from "../utils/logger.js";

export interface AdoMcpOptions {
  organization: string;
  /** Tool domains to load, e.g. ["core", "work-items", "repositories"]. Omit for the server's default set. */
  domains?: string[];
  email: string;
  pat: string;
  /** Forward the MCP server's own stderr (startup logs, npm install chatter) instead of swallowing it. */
  verbose?: boolean;
}

export interface AdoCallResult {
  text: string;
  isError: boolean;
}

export interface AdoMcpConnection {
  /** Every tool the server exposes, adapted for the model. Prefer `call` + a curated prompt for small models. */
  tools: ToolHandler[];
  /** Calls one MCP tool directly (no model involved) and reports whether the server flagged it as an error. */
  call: (name: string, args: Record<string, unknown>) => Promise<AdoCallResult>;
  close: () => Promise<void>;
}

function textOf(result: object): string {
  const content = (result as { content?: unknown }).content;
  const blocks: Array<{ type?: string; text?: string }> = Array.isArray(content) ? content : [];
  return blocks
    .filter((block): block is { type: "text"; text: string } => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/** Spawns the official Azure DevOps MCP server over stdio and exposes its tools as ToolHandlers. */
export async function connectAdoMcp(opts: AdoMcpOptions): Promise<AdoMcpConnection> {
  const authToken = Buffer.from(`${opts.email}:${opts.pat}`, "utf-8").toString("base64");

  const args = ["-y", "@azure-devops/mcp", opts.organization, "--authentication", "pat"];
  if (opts.domains?.length) {
    args.push("-d", ...opts.domains);
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args,
    env: {
      ...getDefaultEnvironment(),
      PERSONAL_ACCESS_TOKEN: authToken,
    },
    // Default "inherit" dumps the server's own startup JSON log + npm install
    // chatter straight into our CLI's console. Pipe it and only forward it
    // when the caller actually wants to see it.
    stderr: "pipe",
  });

  const stderrStream = transport.stderr;
  if (stderrStream) {
    stderrStream.on("data", (chunk: Buffer) => {
      if (!opts.verbose) return;
      for (const line of chunk.toString("utf-8").split("\n")) {
        if (line.trim()) logger.info(`  [ado-mcp] ${line.trim()}`);
      }
    });
  }

  const client = new Client({ name: "traceforge", version: "0.1.0" });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();
  if (opts.verbose) {
    logger.info(`  Azure DevOps MCP tools (${mcpTools.length}): ${mcpTools.map((t) => t.name).join(", ")}`);
  }

  const call = async (name: string, args: Record<string, unknown>): Promise<AdoCallResult> => {
    const result = await client.callTool({ name, arguments: args });
    return { text: textOf(result), isError: result.isError === true };
  };

  const tools: ToolHandler[] = mcpTools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    execute: async (args) => (await call(tool.name, args)).text,
  }));

  return {
    tools,
    call,
    close: () => client.close(),
  };
}
