import { describe, expect, it } from "vitest";
import {
  contextOverflowMessage,
  estimateTokens,
  inputCharBudget,
  outputTokenBudget,
  parseContextOverflow,
  toolDefinitionChars,
  toolResultCharLimit,
  truncateText,
} from "./contextBudget.js";

describe("outputTokenBudget", () => {
  it("keeps the wanted answer size on a large window and on an unknown one", () => {
    expect(outputTokenBudget(32_768)).toBe(1200);
    expect(outputTokenBudget(undefined)).toBe(1200);
    expect(outputTokenBudget(null)).toBe(1200);
  });

  it("shrinks the answer space on a small window so it can't crowd out the input (phi-4-mini NPU: 4224)", () => {
    expect(outputTokenBudget(4224)).toBe(1056);
    expect(outputTokenBudget(2048)).toBe(512);
    expect(outputTokenBudget(600)).toBe(256); // never below a floor
  });
});

describe("inputCharBudget", () => {
  it("is unlimited when the window is unknown", () => {
    expect(inputCharBudget(undefined, 1200, 5000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("subtracts the answer space, headroom and the fixed parts of the prompt", () => {
    // (4224 - 1056 - 200) tokens * 3 chars - 2000 fixed chars
    expect(inputCharBudget(4224, 1056, 2000)).toBe((4224 - 1056 - 200) * 3 - 2000);
  });

  it("never goes negative, however large the fixed part is", () => {
    expect(inputCharBudget(4224, 1056, 1_000_000)).toBe(0);
  });

  it("would have kept the reported failure inside the window", () => {
    // The real failure: 4215 input + 1200 output = 5415 > 4224. With the budget, input + output must fit.
    const out = outputTokenBudget(4224);
    const inputChars = inputCharBudget(4224, out, 0);
    expect(estimateTokens("x".repeat(inputChars)) + out).toBeLessThanOrEqual(4224);
  });
});

describe("toolResultCharLimit", () => {
  it("caps a single tool result well below a small window (a 20,000-char file read is ~6,000 tokens)", () => {
    expect(toolResultCharLimit(4224)).toBeLessThan(4224 * 3);
    expect(toolResultCharLimit(4224)).toBe(3801);
  });

  it("allows the full ceiling on a large window and when the window is unknown", () => {
    expect(toolResultCharLimit(131_072)).toBe(20_000);
    expect(toolResultCharLimit(undefined)).toBe(20_000);
  });

  it("keeps a usable minimum on a tiny window", () => {
    expect(toolResultCharLimit(500)).toBe(1_200);
  });
});

describe("truncateText", () => {
  it("leaves short text alone and marks truncated text, staying within the limit", () => {
    expect(truncateText("short", 100)).toBe("short");
    const out = truncateText("x".repeat(500), 200);
    expect(out.length).toBe(200);
    expect(out).toContain("[truncated");
  });

  it("does nothing when the limit is unlimited", () => {
    expect(truncateText("x".repeat(500), Number.POSITIVE_INFINITY)).toHaveLength(500);
  });
});

describe("toolDefinitionChars", () => {
  it("sums names, descriptions and schemas", () => {
    const tools = [{ name: "ab", description: "cde", parameters: { type: "object" } }];
    expect(toolDefinitionChars(tools)).toBe(2 + 3 + JSON.stringify({ type: "object" }).length);
  });
});

describe("context overflow errors", () => {
  const real =
    "search_options.cc:46 fl::ApplySearchOptions request requires 5415 total tokens (4215 input + 1200 output), which exceeds the model's maximum context length of 4224 tokens";

  it("recognises the runtime's error and reads the window size from it", () => {
    expect(parseContextOverflow(real)).toEqual({ limit: 4224 });
    expect(parseContextOverflow("some other failure")).toBeUndefined();
  });

  it("explains it in plain English with what to do", () => {
    const msg = contextOverflowMessage("phi-4-mini", { limit: 4224 });
    expect(msg).toContain("4224-token context window");
    expect(msg).toContain("narrower question");
    expect(msg).not.toContain("search_options.cc");
  });
});
