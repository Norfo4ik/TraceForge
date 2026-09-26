import { describe, expect, it } from "vitest";
import type { Item } from "foundry-local-sdk";
import { extractAnswerText } from "./agentLoop.js";

const assistant = (fields: { content?: string; parts?: Array<{ text: string; textType?: string }> }) =>
  ({
    type: "message",
    role: "assistant",
    content: fields.content,
    parts: fields.parts?.map((p) => ({ type: "text", ...p })),
  }) as unknown as Item;

describe("extractAnswerText", () => {
  it("returns the answer once when the runtime supplies it as both `content` and a text part", () => {
    // Real shape from phi-4-mini on the NPU: no separate reasoning part, so `content` mirrors the single part.
    const text = "This repo is a CLI.";
    const out = extractAnswerText([assistant({ content: text, parts: [{ text, textType: "default" }] })]);
    expect(out).toBe(text);
  });

  it("drops reasoning parts and keeps only the answer (Qwen3-style output)", () => {
    const out = extractAnswerText([
      assistant({ parts: [{ text: "Let me think about this…", textType: "reasoning" }, { text: "The answer.", textType: "default" }] }),
    ]);
    expect(out).toBe("The answer.");
  });

  it("uses `content` when there are no parts", () => {
    expect(extractAnswerText([assistant({ content: "Just content." })])).toBe("Just content.");
  });

  it("still strips leaked chat-template markers", () => {
    const out = extractAnswerText([assistant({ parts: [{ text: "<think>hmm</think>Final.", textType: "default" }] })]);
    expect(out).toBe("Final.");
  });

  it("ignores user and tool messages", () => {
    const user = { type: "message", role: "user", content: "hello" } as unknown as Item;
    expect(extractAnswerText([user, assistant({ content: "Hi." })])).toBe("Hi.");
  });
});
