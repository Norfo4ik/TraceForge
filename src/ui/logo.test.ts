import { describe, expect, it } from "vitest";
import { LOGO_WIDTH, logoRows, renderLogo } from "./logo.js";

describe("logo", () => {
  it("every letter is 5 columns wide, so all logo rows have the same width", () => {
    const widths = new Set(logoRows().map((r) => r.length));
    expect(widths).toEqual(new Set([LOGO_WIDTH]));
    expect(LOGO_WIDTH).toBe(59);
  });

  it("renders the big logo when the terminal is wide enough", () => {
    const out = renderLogo({ columns: 100, version: "1.2.3", color: false });
    expect(out).toContain("█████");
    expect(out).toContain("v1.2.3");
    for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(100);
  });

  it("falls back to a one-line wordmark on a narrow terminal", () => {
    const out = renderLogo({ columns: 50, version: "1.2.3", color: false });
    expect(out).toContain("◆ TRACEFORGE");
    expect(out).not.toContain("█");
  });
});
