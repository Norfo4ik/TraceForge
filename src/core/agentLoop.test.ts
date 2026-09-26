import { describe, expect, it } from "vitest";
import type { Item } from "foundry-local-sdk";
import { cutRestartedAnswer, describeOutput, extractAnswerText } from "./agentLoop.js";

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

  it("uses the reply once when it is reported both as a top-level text item and inside the message", () => {
    const reply = "This repository is a CLI that traces work items to code.";
    const topLevel = { type: "text", text: reply, textType: "default" } as unknown as Item;
    expect(extractAnswerText([assistant({ content: reply, parts: [{ text: reply, textType: "default" }] }), topLevel])).toBe(reply);
    expect(extractAnswerText([topLevel, assistant({ parts: [{ text: reply, textType: "default" }] })])).toBe(reply);
  });

  it("keeps the longer chunk when one chunk is only a piece of another", () => {
    const full = "First sentence of the answer. Second sentence of the answer.";
    expect(extractAnswerText([assistant({ parts: [{ text: "First sentence of the answer.", textType: "default" }, { text: full, textType: "default" }] })])).toBe(full);
  });
});

describe("cutRestartedAnswer", () => {
  const answer =
    "To provide you with information about the repository, I will list the contents and describe the structure. " +
    "The project is a Node.js CLI written in TypeScript. Its entry point is src/cli.ts and the commands live in src/commands.";

  it("keeps a single copy when the model repeats its answer, even with small differences, and the last copy is cut short", () => {
    const looped = `${answer} ${answer.replace("Node.js CLI", "Node CLI")} ${answer.slice(0, 150)}`;
    expect(cutRestartedAnswer(looped)).toBe(answer);
  });

  it("handles copies glued together with no separator (as in the reported output)", () => {
    expect(cutRestartedAnswer(answer + answer)).toBe(answer);
  });

  it("goes through extractAnswerText, so a looping reply from the runtime is cut to one copy", () => {
    const out = extractAnswerText([assistant({ parts: [{ text: `${answer}\n\n${answer}\n\n${answer.slice(0, 120)}`, textType: "default" }] })]);
    expect(out).toBe(answer);
  });

  it("leaves a normal answer, a short one, and one whose opening recurs only very early untouched", () => {
    expect(cutRestartedAnswer(answer)).toBe(answer);
    expect(cutRestartedAnswer("Yes.")).toBe("Yes.");
    const early = "The result of the calculation is shown here. The result of the calculation is shown here again.";
    expect(cutRestartedAnswer(early)).toBe(early);
  });
});

describe("describeOutput", () => {
  it("summarises item kinds and text lengths for debugging", () => {
    const out = describeOutput([
      { type: "toolCall", callId: "1", name: "read_file", arguments: "{}" } as unknown as Item,
      assistant({ content: "abc", parts: [{ text: "hmm", textType: "reasoning" }, { text: "abc", textType: "default" }] }),
      { type: "text", text: "abcd", textType: "default" } as unknown as Item,
    ]);
    expect(out).toBe("toolCall(read_file) | message(assistant) content=3 parts=[reasoning:3,default:3] | text(default):4");
  });
});
