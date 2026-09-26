import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepoTools, gatherRepoOverview, getRepoRoot, resolveProject } from "./repoTools.js";

function plainFolder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "tf-folder-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("plain folder (no git)", () => {
  const root = plainFolder({
    "README.md": "# My App\nA small tool.",
    "package.json": '{"name":"my-app","scripts":{"start":"node src/index.js"}}',
    "src/index.js": "function retryOnce() {}\nmodule.exports = {};\n",
    "node_modules/dep/index.js": "retryOnce",
  });
  const tools = createRepoTools(root, "folder");
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  it("offers file tools but not the git history tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(["grep_repo", "list_files", "read_file"]);
  });

  it("lists project files (without dependencies) and filters by path text", async () => {
    const all = JSON.parse(await byName.list_files.execute({}));
    expect(all.files).toEqual(["README.md", "package.json", "src/index.js"]);
    const src = JSON.parse(await byName.list_files.execute({ pathspec: "src/" }));
    expect(src.files).toEqual(["src/index.js"]);
  });

  it("searches file contents and reads files, with the same path guard as git mode", async () => {
    const found = JSON.parse(await byName.grep_repo.execute({ pattern: "retryOnce" }));
    expect(found.matches).toEqual(["src/index.js:1:function retryOnce() {}"]);
    const file = JSON.parse(await byName.read_file.execute({ path: "package.json" }));
    expect(file.content).toContain("my-app");
    await expect(byName.read_file.execute({ path: "../outside.txt" })).rejects.toThrow(/escapes the repository root/i);
  });

  it("builds an overview from the files and says there is no commit history", () => {
    const overview = gatherRepoOverview(root, "folder").text;
    expect(overview).toContain("Project files (3):");
    expect(overview).toContain("--- package.json ---");
    expect(overview).toContain("--- README.md ---");
    expect(overview).toContain("not a git repository — there is no commit history");
    expect(overview).not.toContain("node_modules");
  });

  it("resolves a plain folder as a project, and nothing for an empty one", () => {
    expect(resolveProject(root)).toEqual({ root, kind: "folder" });
    expect(resolveProject(plainFolder({}))).toBeUndefined();
  });
});

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
