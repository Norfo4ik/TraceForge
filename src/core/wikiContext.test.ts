import { describe, expect, it } from "vitest";
import { wikiEnabled } from "./wikiContext.js";

const config = { organization: "o", project: "p", domains: [] };

describe("wikiEnabled", () => {
  it("is on for a configured project by default", () => {
    expect(wikiEnabled(config, {})).toBe(true);
  });

  it("is off without Azure DevOps configuration", () => {
    expect(wikiEnabled(undefined, {})).toBe(false);
  });

  it("can be turned off in the project config", () => {
    expect(wikiEnabled({ ...config, wiki: false }, {})).toBe(false);
    expect(wikiEnabled({ ...config, wiki: true }, {})).toBe(true);
  });

  it("can be turned off with TRACEFORGE_WIKI", () => {
    for (const value of ["off", "0", "false", "no", "OFF"]) expect(wikiEnabled(config, { TRACEFORGE_WIKI: value })).toBe(false);
    expect(wikiEnabled(config, { TRACEFORGE_WIKI: "on" })).toBe(true);
  });
});
