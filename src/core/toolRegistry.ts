import type { ChatSession } from "foundry-local-sdk";

export interface ToolHandler {
  name: string;
  description: string;
  /** JSON Schema object describing the tool's parameters (converted to a string for the model). */
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<string>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler>();

  register(tool: ToolHandler): void {
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: ToolHandler[]): void {
    for (const tool of tools) this.register(tool);
  }

  get size(): number {
    return this.tools.size;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  definitions(): ToolHandler[] {
    return [...this.tools.values()];
  }

  /** Registers every tool's definition on a freshly created ChatSession. */
  attachTo(session: ChatSession): void {
    for (const tool of this.tools.values()) {
      session.addToolDefinition({
        name: tool.name,
        description: tool.description,
        jsonSchema: JSON.stringify(tool.parameters),
      });
    }
  }

  /** Dispatches a model tool call by name, returning a string result (or a JSON error payload). */
  async execute(name: string, argumentsJson: string): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    let args: Record<string, unknown>;
    try {
      args = argumentsJson ? JSON.parse(argumentsJson) : {};
    } catch {
      return JSON.stringify({ error: "Tool call arguments were not valid JSON" });
    }

    try {
      return await tool.execute(args);
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}
