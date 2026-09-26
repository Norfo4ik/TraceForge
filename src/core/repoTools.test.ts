import { describe, expect, it } from "vitest";
import { createRepoTools, getRepoRoot } from "./repoTools.js";

describe("repoTools", () => {
  const repoRoot = getRepoRoot();
  const tools = createRepoTools(repoRoot);
  const readFile = tools.find((t) => t.name === "read_file")!;
  const listFiles = tools.find((t) => t.name === "list_files")!;
  const grepRepo = tools.find((t) => t.name === "grep_repo")!;

  it("reads a real file relative to the repo root", async () => {
    const result = JSON.parse(await readFile.execute({ path: "package.json" }));
    expect(result.path).toBe("package.json");
    expect(result.content).toContain("traceforge");
  });

  it("rejects an absolute path", async () => {
    await expect(readFile.execute({ path: "C:/Windows/win.ini" })).rejects.toThrow(/relative to the repository root/i);
  });

  it("rejects a path that escapes the repo root via ..", async () => {
    await expect(readFile.execute({ path: "../../../../etc/passwd" })).rejects.toThrow(/escapes the repository root/i);
  });

  it("lists git-tracked files including package.json", async () => {
    const result = JSON.parse(await listFiles.execute({}));
    expect(result.files).toContain("package.json");
  });

  it("greps for a known symbol in the repo", async () => {
    const result = JSON.parse(await grepRepo.execute({ pattern: "createRepoTools" }));
    expect(result.count).toBeGreaterThan(0);
  });

  it("returns zero matches (not an error) for a pattern with no hits", async () => {
    // Built from two halves so this test's own source line never contains the literal pattern.
    const pattern = ["definitely-not", "-a-real-symbol-xyz123"].join("");
    const result = JSON.parse(await grepRepo.execute({ pattern }));
    expect(result.count).toBe(0);
  });
});
