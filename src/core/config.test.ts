import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveUserCredentials } from "./config.js";

describe("saveUserCredentials", () => {
  it("writes the two ADO_* lines and keeps unrelated settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-cred-"));
    writeFileSync(join(dir, ".env"), "TRACEFORGE_MODEL=qwen2.5-coder-7b\nADO_PAT=old\n");

    const path = saveUserCredentials("me@example.com", "new-token", dir);
    const lines = readFileSync(path, "utf-8").trim().split("\n");

    expect(lines).toContain("TRACEFORGE_MODEL=qwen2.5-coder-7b");
    expect(lines).toContain("ADO_EMAIL=me@example.com");
    expect(lines).toContain("ADO_PAT=new-token");
    expect(lines.filter((l) => l.startsWith("ADO_PAT="))).toHaveLength(1);
  });

  it("creates the directory when it does not exist yet", () => {
    const base = mkdtempSync(join(tmpdir(), "tf-cred-"));
    const path = saveUserCredentials("a@b.c", "tok", join(base, "nested", "dir"));
    expect(readFileSync(path, "utf-8")).toContain("ADO_EMAIL=a@b.c");
  });

  it("refuses values containing line breaks (would corrupt the file)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-cred-"));
    expect(() => saveUserCredentials("a@b.c", "tok\nEVIL=1", dir)).toThrow(/line breaks/);
  });
});
