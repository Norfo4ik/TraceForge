import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureGitignored } from "./gitignore.js";

function tempRepo(gitignore?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ldc-"));
  if (gitignore !== undefined) writeFileSync(join(dir, ".gitignore"), gitignore);
  return dir;
}

describe("ensureGitignored", () => {
  it("creates a .gitignore when there is none", () => {
    const dir = tempRepo();
    expect(ensureGitignored(dir, [".traceforge/", ".env"])).toEqual([".traceforge/", ".env"]);
    expect(readFileSync(join(dir, ".gitignore"), "utf-8")).toContain(".traceforge/");
  });

  it("appends only missing entries and keeps existing content and CRLF line endings", () => {
    const dir = tempRepo("bin/\r\nobj/\r\n.env\r\n");
    expect(ensureGitignored(dir, [".traceforge/", ".env"])).toEqual([".traceforge/"]);
    const after = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(after.startsWith("bin/\r\nobj/\r\n.env\r\n")).toBe(true);
    expect(after).toContain(".traceforge/\r\n");
  });

  it("treats an equivalent existing entry (no trailing slash / leading slash) as present", () => {
    const dir = tempRepo("/.traceforge\n.env\n");
    expect(ensureGitignored(dir, [".traceforge/", ".env"])).toEqual([]);
  });
});
