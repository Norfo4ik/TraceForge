import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../version.js";
import { renderStatus, type Status } from "./status.js";

describe("renderStatus", () => {
  const base: Status = { credentials: true, email: "me@example.com", model: "qwen3-4b", npu: "none" };

  it("shows repo, Azure DevOps sign-in and the on-device AI device", () => {
    const out = renderStatus(
      { ...base, repoRoot: "C:/repos/Demo", branch: "main", config: { organization: "Contoso", project: "Demo", domains: [] }, device: "CPU (CPUExecutionProvider)", npu: "registered" },
      false
    );
    expect(out).toContain("Demo  (main)");
    expect(out).toContain("Contoso / Demo");
    expect(out).toContain("signed in as me@example.com");
    expect(out).toContain("qwen3-4b on CPU (CPUExecutionProvider)");
    expect(out).toContain("NPU ready");
  });

  it("tells the user what to do when things are missing", () => {
    const outsideRepo = renderStatus({ ...base, credentials: false }, false);
    expect(outsideRepo).toContain("not inside a git repository");

    const unconfigured = renderStatus({ ...base, repoRoot: "C:/repos/Demo" }, false);
    expect(unconfigured).toContain("Set up this repository");

    const signedOut = renderStatus(
      { ...base, credentials: false, repoRoot: "C:/repos/Demo", config: { organization: "Contoso", project: "Demo", domains: [] } },
      false
    );
    expect(signedOut).toContain("not signed in");
  });
});

describe("VERSION", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8"));
    expect(VERSION).toBe(pkg.version);
  });
});
