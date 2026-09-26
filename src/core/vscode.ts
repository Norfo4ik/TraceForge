import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface GeneratedFile {
  /** Path relative to the repo root. */
  path: string;
  content: string;
}

/** Command-palette tasks (Terminal ▸ Run Task) plus an MCP registration for Copilot agent mode. */
export function vscodeFiles(): GeneratedFile[] {
  const task = (label: string, command: string) => ({
    label: `TraceForge: ${label}`,
    type: "shell",
    command,
    problemMatcher: [],
    presentation: { reveal: "always", panel: "dedicated", clear: true },
  });

  const tasks = {
    version: "2.0.0",
    tasks: [
      task("Investigate work item", "traceforge investigate ${input:workItemId}"),
      task("Investigate work item and post comment", "traceforge investigate ${input:workItemId} --post-comment"),
      task("Generate repository docs", "traceforge docs"),
      task("Doctor (check setup)", "traceforge doctor"),
    ],
    inputs: [{ id: "workItemId", type: "promptString", description: "Azure DevOps work item ID" }],
  };

  const mcp = {
    servers: {
      "traceforge-repo": { type: "stdio", command: "traceforge", args: ["mcp"] },
    },
  };

  return [
    { path: ".vscode/tasks.json", content: JSON.stringify(tasks, null, 2) + "\n" },
    { path: ".vscode/mcp.json", content: JSON.stringify(mcp, null, 2) + "\n" },
  ];
}

/** Writes each file only if it doesn't already exist — never overwrites or merges into the user's own config. */
export function writeVscodeFiles(repoRoot: string): { created: string[]; skipped: string[] } {
  const created: string[] = [];
  const skipped: string[] = [];
  for (const file of vscodeFiles()) {
    const abs = join(repoRoot, file.path);
    if (existsSync(abs)) {
      skipped.push(file.path);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, file.content, "utf-8");
    created.push(file.path);
  }
  return { created, skipped };
}
