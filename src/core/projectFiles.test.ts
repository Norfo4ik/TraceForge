import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
import { describe, expect, it } from "vitest";
import { grepFiles, looksLikeProject, walkProject } from "./projectFiles.js";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "tf-proj-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("walkProject", () => {
  it("lists source files with forward slashes and skips dependency, build and tool folders and binaries", () => {
    const root = project({
      "README.md": "# hi",
      "src/app.ts": "export {}",
      "src/util/helpers.ts": "export {}",
      "node_modules/left-pad/index.js": "x",
      "bin/Debug/app.dll": "x",
      "obj/project.assets.json": "x",
      ".git/config": "x",
      "logo.png": "x",
      "package-lock.json": "{}",
    });
    expect(walkProject(root).files).toEqual(["README.md", "src/app.ts", "src/util/helpers.ts"]);
  });

  it("stops at the file limit and says the list is partial", () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${String(i).padStart(2, "0")}.ts`, "x"]));
    const result = walkProject(project(many), { maxFiles: 10 });
    expect(result.files).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  it("respects the depth limit", () => {
    const root = project({ "a/b/c/d/deep.ts": "x", "a/top.ts": "x" });
    expect(walkProject(root, { maxDepth: 2 }).files).toEqual(["a/top.ts"]);
  });
});

describe("looksLikeProject", () => {
  it("accepts a folder with source or doc files", () => {
    expect(looksLikeProject(project({ "src/main.py": "print(1)" }))).toBe(true);
    expect(looksLikeProject(project({ "notes/readme.md": "hello" }))).toBe(true);
  });

  it("rejects an empty folder, one with only binaries, the home folder and a drive root", () => {
    expect(looksLikeProject(project({}))).toBe(false);
    expect(looksLikeProject(project({ "photo.png": "x", "movie.mp4": "x" }))).toBe(false);
    expect(looksLikeProject(homedir())).toBe(false);
    expect(looksLikeProject(parse(process.cwd()).root)).toBe(false);
  });
});

describe("grepFiles", () => {
  const root = project({
    "a.ts": "const retryCount = 3;\nfunction retry() {}\n",
    "b.ts": "// nothing here\n",
    "c.bin.ts": "has\0nul retry",
    "big.ts": "retry ".repeat(200),
  });

  it("returns file:line:text for matches and treats an invalid regex as plain text", () => {
    expect(grepFiles(root, ["a.ts", "b.ts"], "retry\\w*")).toEqual(["a.ts:1:const retryCount = 3;", "a.ts:2:function retry() {}"]);
    // "retry(" isn't a valid regex, so it is searched as literal text — which does occur in "function retry() {}".
    expect(grepFiles(root, ["a.ts"], "retry(")).toEqual(["a.ts:2:function retry() {}"]);
  });

  it("skips binary files and files over the size limit, and caps results", () => {
    expect(grepFiles(root, ["c.bin.ts"], "retry")).toEqual([]);
    expect(grepFiles(root, ["big.ts"], "retry", { maxFileBytes: 100 })).toEqual([]);
    expect(grepFiles(root, ["a.ts"], "retry", { maxResults: 1 })).toHaveLength(1);
  });
});
