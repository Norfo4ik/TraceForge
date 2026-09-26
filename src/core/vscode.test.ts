import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { vscodeFiles, writeVscodeFiles } from "./vscode.js";

describe("vscodeFiles", () => {
  it("produces valid JSON whose tasks call the CLI and prompt for the work item id", () => {
    const tasks = vscodeFiles().find((f) => f.path === ".vscode/tasks.json")!;
    const parsed = JSON.parse(tasks.content);
    const commands = parsed.tasks.map((t: { command: string }) => t.command);
    expect(commands).toContain("traceforge investigate ${input:workItemId}");
    expect(parsed.inputs[0].id).toBe("workItemId");
  });

  it("registers the repo tools MCP server as a stdio server", () => {
    const mcp = JSON.parse(vscodeFiles().find((f) => f.path === ".vscode/mcp.json")!.content);
    expect(mcp.servers["traceforge-repo"]).toEqual({ type: "stdio", command: "traceforge", args: ["mcp"] });
  });
});

describe("writeVscodeFiles", () => {
  it("never overwrites files the user already has", () => {
    const dir = mkdtempSync(join(tmpdir(), "ldc-vs-"));
    mkdirSync(join(dir, ".vscode"));
    writeFileSync(join(dir, ".vscode", "tasks.json"), "// mine\n");

    const result = writeVscodeFiles(dir);
    expect(result.skipped).toEqual([".vscode/tasks.json"]);
    expect(result.created).toEqual([".vscode/mcp.json"]);
    expect(readFileSync(join(dir, ".vscode", "tasks.json"), "utf-8")).toBe("// mine\n");
  });
});
