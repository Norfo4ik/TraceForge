/**
 * Models have a fixed context window (input + output must fit). Small windows are common on NPUs — the phi-4-mini NPU
 * build reports 4,224 tokens — and a big repository's overview alone can fill that, which the runtime rejects with
 * "requires 5415 total tokens (4215 input + 1200 output), which exceeds the model's maximum context length of 4224".
 * These helpers size the prompt, the answer and tool results to the window instead of hoping they fit.
 */

/** Deliberately pessimistic: code, paths and JSON tokenise worse than English (~4 chars/token). */
export const CHARS_PER_TOKEN = 3;

/** Headroom for the chat template, role markers and tool-definition formatting that we can't measure exactly. */
const SAFETY_TOKENS = 200;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * How many tokens to reserve for the answer: what we'd like (`wanted`), but never more than a quarter of a small
 * window — otherwise the answer space would crowd out the input. Unknown window: no restriction.
 */
export function outputTokenBudget(contextLength: number | null | undefined, wanted = 1200): number {
  if (!contextLength) return wanted;
  return Math.min(wanted, Math.max(256, Math.floor(contextLength * 0.25)));
}

/**
 * Characters available for the variable part of the prompt (e.g. the repository overview) once the fixed parts
 * (system prompt, tool definitions, the question) and the reserved answer space are accounted for. Unknown window:
 * unlimited. Never negative.
 */
export function inputCharBudget(
  contextLength: number | null | undefined,
  outputTokens: number,
  fixedChars: number
): number {
  if (!contextLength) return Number.POSITIVE_INFINITY;
  const inputTokens = contextLength - outputTokens - SAFETY_TOKENS;
  return Math.max(0, inputTokens * CHARS_PER_TOKEN - fixedChars);
}

/** Longest tool result to feed back to the model: a fraction of the window, within sane bounds. */
export function toolResultCharLimit(contextLength: number | null | undefined, ceiling = 20_000): number {
  if (!contextLength) return ceiling;
  return Math.min(ceiling, Math.max(1_200, Math.floor(contextLength * 0.3 * CHARS_PER_TOKEN)));
}

export function truncateText(text: string, maxChars: number, note = "\n… [truncated to fit the model's context window]"): string {
  if (!Number.isFinite(maxChars) || text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - note.length);
  return text.slice(0, keep) + note;
}

/** Rough size of the tool definitions the model is sent (name, description and JSON schema of each). */
export function toolDefinitionChars(tools: ReadonlyArray<{ name: string; description: string; parameters: unknown }>): number {
  return tools.reduce((sum, t) => sum + t.name.length + t.description.length + JSON.stringify(t.parameters).length, 0);
}

export interface ContextOverflow {
  /** The model's window in tokens, as reported by the runtime. */
  limit: number;
}

/** Recognises the runtime's "exceeds the model's maximum context length of N tokens" error. */
export function parseContextOverflow(message: string): ContextOverflow | undefined {
  const m = /maximum context length of (\d+) tokens/i.exec(message);
  return m ? { limit: Number(m[1]) } : undefined;
}

export function contextOverflowMessage(model: string, overflow: ContextOverflow): string {
  return (
    `That is more than ${model}'s ${overflow.limit}-token context window can hold. ` +
    `Ask a narrower question (name a file or a function), or use a model with a larger window ` +
    `(set TRACEFORGE_MODEL; "traceforge doctor" lists the models available on this machine).`
  );
}
