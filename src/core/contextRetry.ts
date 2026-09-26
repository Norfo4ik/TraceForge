import { ContextOverflowError } from "./agentLoop.js";

export interface ContextRetryOptions {
  /** The window we believe the model has (catalog metadata, or a limit learned earlier); undefined when unknown. */
  known: number | undefined;
  /** Called with the window the runtime reported, so later runs can size prompts up front. */
  remember: (limit: number) => void;
}

const MAX_ATTEMPTS = 3;
const SAFETY_STEP = 0.75;

/**
 * Runs `attempt` sized to the best-known context window, and recovers when the runtime rejects the prompt as too big:
 *
 * - The catalog often doesn't report a model's window (it printed "unknown" for the models we tried), so the first
 *   oversized prompt fails with the runtime's own error, which states the real limit. Learn it, remember it, retry.
 * - If the window was already right and the prompt still doesn't fit, our token estimate was too optimistic for this
 *   text (code and paths tokenise unpredictably). Retry with a further 25% safety margin. The margin is not remembered:
 *   it's about this text, not this model.
 *
 * Gives up after three attempts — a prompt that still overflows then is a real failure, not something to loop on.
 */
export async function runWithContextRetry<T>(
  options: ContextRetryOptions,
  attempt: (contextLength: number | undefined) => Promise<T>
): Promise<T> {
  let window = options.known;
  let margin = 1;
  for (let tries = 1; ; tries++) {
    try {
      return await attempt(window === undefined ? undefined : Math.floor(window * margin));
    } catch (err) {
      if (!(err instanceof ContextOverflowError) || tries >= MAX_ATTEMPTS) throw err;
      if (window === undefined || err.limit < window) {
        window = err.limit;
        options.remember(err.limit);
      } else {
        margin *= SAFETY_STEP;
      }
    }
  }
}
