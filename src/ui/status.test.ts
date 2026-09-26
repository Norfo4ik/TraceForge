import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILD_COMMIT, VERSION, VERSION_LABEL } from "../version.js";
import { renderStatus, type Status } from "./status.js";

describe("renderStatus", () => {
  const base: Status = { credentials: true, email: "me@example.com", model: "qwen3-4b", npu: "none" };

  it("shows repo, Azure DevOps sign-in and the on-device AI device", () => {
    const out = renderStatus(
      { ...base, repoRoot: "C:/repos/Demo", branch: "main", config: { organization: "Contoso", project: "Demo", domains: [] }, device: "CPU (CPUExecutionProvider)", npu: "none" },
      false
    );
    expect(out).toContain("Demo  (main)");
    expect(out).toContain("Contoso / Demo");
    expect(out).toContain("signed in as me@example.com");
    expect(out).toContain("qwen3-4b on CPU (CPUExecutionProvider)");
    expect(out).toContain("no NPU on this machine");
  });

  it("says when the model is running on the NPU, and when an NPU is ready but unused", () => {
    const onNpu = renderStatus({ ...base, model: "phi-3.5-mini", device: "NPU (OpenVINOExecutionProvider)", npu: "registered", switchedFrom: "qwen3-4b" }, false);
    expect(onNpu).toContain("phi-3.5-mini on NPU (OpenVINOExecutionProvider)");
    expect(onNpu).toContain("running on the NPU");
    expect(onNpu).toContain("auto-selected: qwen3-4b has no NPU build here");

    const unused = renderStatus({ ...base, device: "CPU (CPUExecutionProvider)", npu: "registered" }, false);
    expect(unused).toContain("NPU ready, but this model isn't using it");
  });

  it("says when the model still has to be downloaded, with its size", () => {
    expect(renderStatus({ ...base, model: "phi-4-mini", device: "NPU (OpenVINOExecutionProvider)", npu: "registered", modelCached: false, modelSizeMb: 2200 }, false)).toContain(
      "not downloaded yet (2.2 GB)"
    );
    expect(renderStatus({ ...base, modelCached: false }, false)).toContain("not downloaded yet");
    expect(renderStatus({ ...base, modelCached: true, modelSizeMb: 2200 }, false)).not.toContain("not downloaded");
  });

  it("tells the user what to do when things are missing", () => {
    const outsideRepo = renderStatus({ ...base, credentials: false }, false);
    expect(outsideRepo).toContain("no project here");

    const plainFolder = renderStatus({ ...base, projectRoot: "C:/work/MyApp", projectKind: "folder" }, false);
    expect(plainFolder).toContain("MyApp");
    expect(plainFolder).toContain("a folder, not a git repository — Ask works here");

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

  it("labels the build with its commit, or 'dev' when run from source", () => {
    expect(VERSION_LABEL).toBe(`${VERSION} (${BUILD_COMMIT})`);
    expect(BUILD_COMMIT).toBe("dev"); // tests run from source, where the build stamp isn't injected
  });
});
