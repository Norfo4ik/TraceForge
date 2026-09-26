import { describe, expect, it } from "vitest";
import { clarifyBroadQuestion } from "./ask.js";

describe("clarifyBroadQuestion", () => {
  it.each(["what about this repo?", "Tell me about this project", "explain this repository", "what is this codebase"])(
    "adds a concrete summary request to the broad question %j",
    (q) => {
      const out = clarifyBroadQuestion(q);
      expect(out.startsWith(q)).toBe(true);
      expect(out).toContain("short summary of the project");
    }
  );

  it.each([
    "what does chooseVariant do?",
    "open src/core/accelerators.ts and explain it",
    'where is "retry" handled in this repo?',
    "why does agent_loop retry in this project",
    "how does package.json define the build",
  ])("leaves the specific question %j untouched", (q) => {
    expect(clarifyBroadQuestion(q)).toBe(q);
  });

  it("leaves long questions and empty input alone", () => {
    const long = "in this repo can you walk me through everything that happens when a user runs the investigate command end to end";
    expect(clarifyBroadQuestion(long)).toBe(long);
    expect(clarifyBroadQuestion("   ")).toBe("");
  });
});
