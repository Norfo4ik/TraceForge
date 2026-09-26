import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadUserSettings, saveUserCredentials, saveUserSettings } from "./config.js";

describe("user settings", () => {
  it("reports no decision when there is no file, and remembers yes/no once saved", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-set-"));
    expect(loadUserSettings(dir)).toEqual({});
    saveUserSettings({ accelerators: true }, dir);
    expect(loadUserSettings(dir)).toEqual({ accelerators: true });
    saveUserSettings({ accelerators: false }, dir);
    expect(loadUserSettings(dir)).toEqual({ accelerators: false });
  });

  it("keeps the accelerator decision when the blocked-builds list is updated, and can clear it", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-set-"));
    saveUserSettings({ accelerators: true }, dir);
    saveUserSettings({ blockedBuilds: ["phi-4-mini-instruct-openvino-npu:4"] }, dir);
    expect(loadUserSettings(dir)).toEqual({ accelerators: true, blockedBuilds: ["phi-4-mini-instruct-openvino-npu:4"] });
    saveUserSettings({ blockedBuilds: [] }, dir);
    expect(loadUserSettings(dir).blockedBuilds).toEqual([]);
  });

  it("ignores non-string entries in the blocked-builds list", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-set-"));
    writeFileSync(join(dir, "settings.json"), '{"blockedBuilds":["ok:1",7,null]}');
    expect(loadUserSettings(dir).blockedBuilds).toEqual(["ok:1"]);
  });

  it("treats a corrupt or wrongly-typed file as no decision instead of failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-set-"));
    writeFileSync(join(dir, "settings.json"), "{ not json");
    expect(loadUserSettings(dir)).toEqual({});
    writeFileSync(join(dir, "settings.json"), '{"accelerators":"yes"}');
    expect(loadUserSettings(dir)).toEqual({});
  });
});

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
