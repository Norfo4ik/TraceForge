import { ChatSession, Item, Request, type IModel, type ToolCallItem } from "foundry-local-sdk";
import ora from "ora";
import type { ToolRegistry } from "./toolRegistry.js";
import {
  contextOverflowMessage,
  outputTokenBudget,
  parseContextOverflow,
  toolResultCharLimit,
  truncateText,
} from "./contextBudget.js";
import { debugEnabled } from "../utils/debug.js";
import { logger } from "../utils/logger.js";

const MAX_TOOL_ITERATIONS = 8;
const MAX_DEGENERATE_RETRIES = 1;

/**
 * The model's final reply arrives as a MessageItem(role: "assistant") whose
 * `parts` mix "reasoning" text (visible chain-of-thought) with the "default"
 * answer text — this pulls out only the latter, across every assistant
 * message in the response (there's one per turn, but tool-call turns can
 * still carry one alongside the ToolCallItem).
 */
export function extractAnswerText(output: readonly Item[]): string {
  const chunks: string[] = [];
  for (const item of output) {
    if (item.type === "text" && (item.textType ?? "default") === "default") {
      chunks.push(item.text);
    } else if (item.type === "message" && item.role === "assistant") {
      const answerParts = (item.parts ?? []).flatMap((part) =>
        part.type === "text" && (part.textType ?? "default") === "default" ? [part.text] : []
      );
      // `content` is a convenience copy of a single default text part, so it must only stand in when there are no
      // parts — otherwise the same answer is added twice (seen with phi-4-mini, which has no separate reasoning part).
      if (answerParts.length > 0) chunks.push(...answerParts);
      else if (item.content) chunks.push(item.content);
    }
  }
  // Defensive cleanup: this model occasionally leaks raw chat-template markers into a
  // "default"-typed part instead of keeping them structured — a stray <think>/</think>
  // boundary (often right where the output-token cap cuts generation off), or a whole
  // hallucinated <tool_response> block echoing data it already has (safe to discard
  // outright — it's simply restating a tool result, never the answer itself).
  const cleaned = dedupeChunks(chunks)
    .join("")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/gi, "")
    .replace(/<\/?tool_response>/gi, "")
    .replace(/<\/?tool_call>/gi, "")
    .trim();
  return cutRestartedAnswer(cleaned);
}

/**
 * The runtime can report the same reply in more than one place (a top-level text item and again inside the message).
 * Drop any chunk that is identical to, or wholly contained in, another chunk so the reply is used once.
 */
function dedupeChunks(chunks: string[]): string[] {
  return chunks.filter((chunk, i) => {
    const text = chunk.trim();
    if (!text) return false;
    return !chunks.some((other, j) => {
      if (j === i) return false;
      const o = other.trim();
      return o.length > text.length ? o.includes(text) : o === text && j < i;
    });
  });
}

/**
 * Some models (seen with phi-4-mini) finish their answer and then start it again from the top, repeating until the
 * output limit cuts the last copy short — "the same text almost three times". Copies aren't byte-identical, so instead
 * of comparing whole texts, look for the answer's own opening (its first ~60 characters) reappearing later and keep
 * only what comes before that point. Requires the restart to be well into the text so a short repeated phrase can't
 * truncate a genuine answer.
 */
export function cutRestartedAnswer(text: string): string {
  const trimmed = text.trim();
  const opening = trimmed.slice(0, 60).trim();
  if (opening.length < 40) return trimmed;
  const restart = trimmed.indexOf(opening, opening.length);
  return restart >= 100 ? trimmed.slice(0, restart).trim() : trimmed;
}

/** One line describing what a response contained (item kinds and text lengths) — for TRACEFORGE_DEBUG. */
export function describeOutput(output: readonly Item[]): string {
  return output
    .map((item) => {
      if (item.type === "message") {
        const parts = (item.parts ?? []).map((p) => (p.type === "text" ? `${p.textType ?? "default"}:${p.text.length}` : p.type)).join(",");
        return `message(${item.role}) content=${item.content?.length ?? 0} parts=[${parts}]`;
      }
      if (item.type === "text") return `text(${item.textType ?? "default"}):${item.text.length}`;
      if (item.type === "toolCall") return `toolCall(${item.name})`;
      return item.type;
    })
    .join(" | ");
}

/** Finds the balanced {...} substring starting at or after `fromIndex`, plus the index right after it closes. */
function extractBalancedJson(text: string, fromIndex = 0): { json: string; endIndex: number } | undefined {
  const start = text.indexOf("{", fromIndex);
  if (start === -1) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return { json: text.slice(start, i + 1), endIndex: i + 1 };
    }
  }
  return undefined;
}

/**
 * Small local models occasionally fail to emit a clean native tool call (e.g. trailing
 * garbage after the JSON, or narrating a whole fake `<tool_call>{...}</tool_call>`
 * transcript as plain text) and fall back to `finishReason: "stop"` instead. This scans
 * every balanced {...} blob in the text — not just the first, since an earlier one may
 * be unrelated JSON (e.g. an echoed tool result) — and recovers the first one shaped
 * like an actual tool call so the agent loop can still execute it.
 */
function recoverPseudoToolCall(text: string): { name: string; args: Record<string, unknown> } | undefined {
  let fromIndex = 0;
  while (fromIndex < text.length) {
    const candidate = extractBalancedJson(text, fromIndex);
    if (!candidate) return undefined;
    try {
      const parsed = JSON.parse(candidate.json);
      if (parsed && typeof parsed.name === "string" && parsed.arguments && typeof parsed.arguments === "object") {
        return { name: parsed.name, args: parsed.arguments };
      }
    } catch {
      // Not valid JSON at all — keep scanning past it rather than giving up.
    }
    fromIndex = candidate.endIndex;
  }
  return undefined;
}

/**
 * Small local models occasionally spiral into repeating the same sentence over and over near
 * their output-token cap instead of finishing cleanly. Detects that pattern (a mid-length
 * substring recurring several times) so the caller can retry instead of writing garbage output.
 */
function hasSevereRepetition(text: string): boolean {
  const WINDOW = 40;
  const MAX_OCCURRENCES = 4;
  if (text.length < WINDOW * MAX_OCCURRENCES) return false;
  const window = text.slice(Math.floor(text.length / 3), Math.floor(text.length / 3) + WINDOW);
  if (window.trim().length < WINDOW * 0.6) return false;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf(window, idx)) !== -1) {
    count++;
    if (count > MAX_OCCURRENCES) return true;
    idx += WINDOW;
  }
  return false;
}

/** Real prose is mostly letters and spaces; digit/punctuation soup (e.g. "0.000.00:000…") is a broken generation. */
function isMostlyNonProse(text: string): boolean {
  if (text.length < 80) return false;
  const proseChars = (text.match(/[\p{L}\s]/gu) ?? []).length;
  return proseChars / text.length < 0.6;
}

/** Bullet-list loops repeat whole lines; real docs essentially never repeat the same long line three times. */
function hasRepeatedLines(text: string): boolean {
  const counts = new Map<string, number>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.length < 25) continue;
    const n = (counts.get(line) ?? 0) + 1;
    if (n >= 3) return true;
    counts.set(line, n);
  }
  return false;
}

/** Names the checks an output fails, so a rejection can be explained rather than just reported. */
export function degenerateReasons(text: string): string[] {
  const reasons: string[] = [];
  if (hasSevereRepetition(text)) reasons.push("repeated passage");
  if (hasRepeatedLines(text)) reasons.push("repeated lines");
  if (isMostlyNonProse(text)) reasons.push("mostly non-prose");
  return reasons;
}

/** True when output is unusable: repetition loops or non-prose noise. */
export function isDegenerateText(text: string): boolean {
  return degenerateReasons(text).length > 0;
}

/**
 * Wraps a native ChatSession. We track whether the system prompt has been sent
 * ourselves rather than relying on the SDK's turnCount, since its semantics
 * across tool-call round trips aren't documented.
 */
export interface AgentSession {
  readonly session: ChatSession;
  primed: boolean;
  /** Qwen3 models "think out loud" by default; appending "/no_think" to a user turn is their official off switch. */
  readonly supportsNoThink: boolean;
  /** The model's context window in tokens, when the runtime reports it. Prompts, answers and tool results are sized to it. */
  readonly contextLength?: number;
  /** Longest tool result fed back to the model — a file read can otherwise be bigger than a small window. */
  readonly maxToolResultChars: number;
  readonly modelAlias: string;
}

// Without a cap, an unbounded generation (especially this model's visible "reasoning" chain-of-thought)
// can run for many minutes on CPU with no way to tell a slow turn from a stuck one. This is a ceiling, not
// a target — a turn that naturally finishes early (e.g. a short tool-call decision) is unaffected. Kept
// moderate on purpose: a degenerate generation still has to run its full length before the degeneracy
// check can even see it, so a high cap makes every *bad* turn expensive, not just long good ones.
//
// Deliberately NOT setting presencePenalty/frequencyPenalty here: on this model + CPU execution
// provider they made repetition measurably *worse* (including one run that degenerated into echoing
// the input prompt itself), not better — this backend likely doesn't implement them correctly.
const MAX_OUTPUT_TOKENS = 1200;

export function createSession(model: IModel, tools?: ToolRegistry, options: { contextLength?: number } = {}): AgentSession {
  // An explicit window (learned from an earlier overflow) wins over the catalog metadata, which may be missing or wrong.
  const contextLength = options.contextLength ?? model.contextLength ?? model.info.contextLength ?? undefined;
  const session = new ChatSession(model);
  // On a small window (the phi-4-mini NPU build has 4,224 tokens) the answer space is shrunk so the input still fits.
  session.setOptions({ search: { maxOutputTokens: outputTokenBudget(contextLength, MAX_OUTPUT_TOKENS) } });
  tools?.attachTo(session);
  return {
    session,
    primed: false,
    supportsNoThink: /qwen3/i.test(model.alias),
    contextLength,
    maxToolResultChars: toolResultCharLimit(contextLength),
    modelAlias: model.alias,
  };
}

/** The prompt (plus the reserved answer) didn't fit the model's window. Carries the window size the runtime reported. */
export class ContextOverflowError extends Error {
  constructor(
    message: string,
    readonly limit: number
  ) {
    super(message);
    this.name = "ContextOverflowError";
  }
}

export interface RunTurnOptions {
  verbose?: boolean;
  /**
   * Forces the model to make at least one tool call on the opening request
   * instead of letting it answer straight from its own (often generic)
   * assumptions. Use for tasks that only make sense grounded in real data;
   * leave off for freeform Q&A and for prompts that already contain the data.
   */
  forceToolUse?: boolean;
  /** Spinner label while the model works, e.g. "Analyzing task". Omit for no spinner. */
  statusLabel?: string;
  /**
   * Turns off the model's visible step-by-step "thinking" where it supports that (Qwen3). For writing tasks
   * whose input already contains all the facts, thinking only burns the token budget and can leak into the answer.
   */
  disableThinking?: boolean;
  /**
   * The answer must be a Markdown document. Any preamble before the first heading is dropped, and an answer with
   * no heading at all (typically leaked reasoning like "Okay, let me start by...") is treated as unusable.
   */
  requireHeading?: boolean;
}

/** Spinner that shows what the agent is doing plus elapsed time, so a slow CPU turn never looks like a hang. */
function startStatus(label: string | undefined) {
  if (!label) {
    return { update() {}, log() {}, stop() {} };
  }
  const startedAt = Date.now();
  let current = label;
  const spinner = ora({ text: label }).start();
  const render = () => {
    spinner.text = `${current} (${Math.round((Date.now() - startedAt) / 1000)}s)`;
  };
  const timer = setInterval(render, 1000);
  return {
    update(text: string) {
      current = text;
      render();
    },
    /** Prints a line without corrupting the spinner. */
    log(fn: () => void) {
      spinner.clear();
      fn();
      spinner.render();
    },
    stop() {
      clearInterval(timer);
      spinner.stop();
    },
  };
}

/** Runs one user turn to completion, including any tool-call round trips. Returns the model's final text reply. */
export async function runTurn(
  agent: AgentSession,
  systemPrompt: string,
  userMessage: string,
  tools: ToolRegistry,
  options: RunTurnOptions = {}
): Promise<string> {
  const status = startStatus(options.statusLabel);
  try {
    return await runTurnInner(agent, systemPrompt, userMessage, tools, options, status);
  } catch (err) {
    const overflow = parseContextOverflow(err instanceof Error ? err.message : String(err));
    if (overflow) throw new ContextOverflowError(contextOverflowMessage(agent.modelAlias, overflow), overflow.limit);
    throw err;
  } finally {
    status.stop();
  }
}

async function runTurnInner(
  agent: AgentSession,
  systemPrompt: string,
  userMessage: string,
  tools: ToolRegistry,
  options: RunTurnOptions,
  status: ReturnType<typeof startStatus>
): Promise<string> {
  const noThink = options.disableThinking === true && agent.supportsNoThink;
  const send = async (req: Request) => {
    const response = await agent.session.processRequest(req);
    if (debugEnabled()) status.log(() => logger.info(`  response: finish=${response.finishReason} · ${describeOutput(response.output)}`));
    return response;
  };
  const userTurn = (message: string) => Item.userMessage(noThink ? `${message} /no_think` : message);

  const request = new Request();
  const isFirstMessage = !agent.primed;
  if (isFirstMessage) {
    request.addItem(Item.systemMessage(systemPrompt));
    agent.primed = true;
  }
  request.addItem(userTurn(userMessage));
  if (isFirstMessage && options.forceToolUse && tools.size > 0) {
    request.setOptions({ toolChoice: "required" });
  }

  let response = await send(request);
  let degenerateRetries = 0;

  for (let iterations = 0; iterations < MAX_TOOL_ITERATIONS; iterations++) {
    if (response.finishReason === "toolCalls") {
      const toolCalls = response.output.filter((item): item is ToolCallItem => item.type === "toolCall");
      const followUp = new Request();
      for (const call of toolCalls) {
        status.update(`Running tool ${call.name}`);
        if (options.verbose) {
          status.log(() => logger.info(`  tool call: ${call.name}(${call.arguments})`));
        }
        const result = truncateText(await tools.execute(call.name, call.arguments), agent.maxToolResultChars);
        followUp.addItem(Item.toolResult(call.callId, result));
      }
      status.update(options.statusLabel ?? "Thinking");
      response = await send(followUp);
      continue;
    }

    let text = extractAnswerText(response.output);
    if (options.requireHeading && !text.startsWith("#")) {
      const firstHeading = text.search(/^#{1,3} /m);
      if (firstHeading > 0) text = text.slice(firstHeading);
    }
    const unusable = isDegenerateText(text) || (options.requireHeading === true && !text.startsWith("#"));
    if (unusable && options.verbose) {
      const why = [...degenerateReasons(text), ...(options.requireHeading && !text.startsWith("#") ? ["no heading"] : [])];
      status.log(() => {
        logger.warn(`  rejected output (${text.length} chars) — failed: ${why.join(", ")}`);
        logger.warn(`  start: ${JSON.stringify(text.slice(0, 200))}`);
        logger.warn(`  end:   ${JSON.stringify(text.slice(-300))}`);
      });
    }

    if (unusable && degenerateRetries < MAX_DEGENERATE_RETRIES) {
      degenerateRetries++;
      status.log(() => logger.warn("Model produced unusable output — retrying once"));
      const followUp = new Request();
      followUp.addItem(
        userTurn(
          options.requireHeading
            ? "Your previous answer was unusable (it was not a finished Markdown document, or it repeated itself). Reply again with ONLY the final Markdown document, starting with a # heading. Do not explain your process and do not repeat any sentence."
            : "Your previous answer was unusable (repeated text or noise). Answer again from scratch in plain English: be direct and concise, and do not repeat any sentence."
        )
      );
      response = await send(followUp);
      continue;
    }

    const pseudo = recoverPseudoToolCall(text);
    if (pseudo && tools.names().includes(pseudo.name)) {
      status.update(`Running tool ${pseudo.name}`);
      if (options.verbose) {
        status.log(() => {
          logger.warn(`  model's tool call for "${pseudo.name}" wasn't well-formed — recovering it manually`);
          logger.info(`  tool call: ${pseudo.name}(${JSON.stringify(pseudo.args)})`);
        });
      }
      const result = truncateText(await tools.execute(pseudo.name, JSON.stringify(pseudo.args)), agent.maxToolResultChars);
      const followUp = new Request();
      followUp.addItem(
        Item.userMessage(
          `Tool "${pseudo.name}" returned: ${result}\n\nContinue answering the original question using this result.`
        )
      );
      status.update(options.statusLabel ?? "Thinking");
      response = await send(followUp);
      continue;
    }

    if (unusable) {
      throw new Error(
        "The local model produced unusable output (repeated text, noise, or reasoning instead of a document) even after a retry, so nothing was saved. " +
          "Try again, or use a larger model: set TRACEFORGE_MODEL (e.g. qwen2.5-coder-7b)."
      );
    }

    if (response.finishReason === "length") {
      status.log(() => logger.warn("The model hit its output limit, so the result may be cut off."));
    }
    return text;
  }

  logger.warn(`Hit the ${MAX_TOOL_ITERATIONS}-iteration tool-call cap; returning what the model has so far.`);
  return extractAnswerText(response.output);
}
