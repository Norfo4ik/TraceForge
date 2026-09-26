import { describe, expect, it } from "vitest";
import { ContextOverflowError } from "./agentLoop.js";
import { runWithContextRetry } from "./contextRetry.js";

const overflow = (limit: number) => new ContextOverflowError(`too big for ${limit}`, limit);

describe("runWithContextRetry", () => {
  it("runs once when the prompt fits", async () => {
    const seen: Array<number | undefined> = [];
    const result = await runWithContextRetry({ known: 4224, remember: () => {} }, async (ctx) => {
      seen.push(ctx);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual([4224]);
  });

  it("learns the window from the overflow, remembers it, and retries sized to it (window unknown in the catalog)", async () => {
    const remembered: number[] = [];
    const seen: Array<number | undefined> = [];
    const result = await runWithContextRetry({ known: undefined, remember: (n) => remembered.push(n) }, async (ctx) => {
      seen.push(ctx);
      if (ctx === undefined) throw overflow(4224); // first try: unbudgeted, the reported failure
      return `answer sized to ${ctx}`;
    });
    expect(result).toBe("answer sized to 4224");
    expect(seen).toEqual([undefined, 4224]);
    expect(remembered).toEqual([4224]);
  });

  it("retries with a tighter window when the runtime reports a smaller one than we assumed", async () => {
    const seen: Array<number | undefined> = [];
    const remembered: number[] = [];
    await runWithContextRetry({ known: 8192, remember: (n) => remembered.push(n) }, async (ctx) => {
      seen.push(ctx);
      if (ctx === 8192) throw overflow(4224);
      return "ok";
    });
    expect(seen).toEqual([8192, 4224]);
    expect(remembered).toEqual([4224]);
  });

  it("when the window was right but the token estimate was too optimistic, retries with a 25% margin and does not remember it", async () => {
    const seen: Array<number | undefined> = [];
    const remembered: number[] = [];
    const result = await runWithContextRetry({ known: 4224, remember: (n) => remembered.push(n) }, async (ctx) => {
      seen.push(ctx);
      if ((ctx ?? 0) > 3200) throw overflow(4224); // this text tokenises worse than estimated
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toEqual([4224, 3168]);
    expect(remembered).toEqual([]);
  });

  it("learns the window and then applies the margin if the first sized attempt still overflows", async () => {
    const seen: Array<number | undefined> = [];
    await runWithContextRetry({ known: undefined, remember: () => {} }, async (ctx) => {
      seen.push(ctx);
      if (ctx === undefined || ctx > 3200) throw overflow(4224);
      return "ok";
    });
    expect(seen).toEqual([undefined, 4224, 3168]);
  });

  it("gives up after three attempts — a persistent overflow is a real failure, not something to loop on", async () => {
    let calls = 0;
    await expect(
      runWithContextRetry({ known: 4224, remember: () => {} }, async () => {
        calls++;
        throw overflow(4224);
      })
    ).rejects.toBeInstanceOf(ContextOverflowError);
    expect(calls).toBe(3);
  });

  it("does not retry other errors", async () => {
    let calls = 0;
    await expect(
      runWithContextRetry({ known: undefined, remember: () => {} }, async () => {
        calls++;
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
