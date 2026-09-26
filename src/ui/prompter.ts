import { confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";

export interface Choice<T> {
  name: string;
  value: T;
  description?: string;
  /** true, or a reason string shown next to the greyed-out entry. */
  disabled?: boolean | string;
}

/** The handful of interactions the menu needs — an interface so the menu logic can be tested without a terminal. */
export interface Prompter {
  /** The main menu: Esc does nothing here (only Ctrl+C leaves), so it can't quit by accident. */
  select<T>(message: string, choices: Choice<T>[]): Promise<T>;
  /** The prompts below reject with BackToMenu when the user presses Esc. */
  input(message: string, options?: { default?: string; validate?: (value: string) => true | string }): Promise<string>;
  password(message: string): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
}

/** Thrown by a prompt when the user presses Esc: abandon what you were doing and show the menu again. */
export class BackToMenu extends Error {
  override name = "BackToMenu";
  constructor() {
    super("back to menu");
  }
}

const ember = chalk.rgb(255, 150, 44);
const theme = {
  prefix: { idle: ember("◆"), done: chalk.green("✔") },
  style: {
    highlight: (text: string) => ember.bold(text),
    description: (text: string) => chalk.dim(text),
  },
  icon: { cursor: "▸" },
};

const BACK_HINT = chalk.dim("  (esc: back)");

/**
 * Inquirer prompts have no Esc handling, so watch for it ourselves and abort the prompt through its AbortSignal.
 *
 * This reads the raw input rather than readline's "keypress" events on purpose: readline holds a lone Esc back
 * until a timer decides it isn't the start of an arrow-key sequence, and that timer stops firing for every prompt
 * after the first (found by testing: the second prompt saw its Esc ~14s late, when the next key arrived). On the
 * raw stream a lone Esc is a one-byte chunk, while arrow keys and Alt+key arrive as longer "ESC …" chunks.
 * (Listening for "data" doesn't resume a stream that readline has paused between prompts.)
 */
async function cancellable<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let escaped = false;
  const onData = (chunk: Buffer | string) => {
    if (chunk.toString() === "\x1b") {
      escaped = true;
      controller.abort();
    }
  };
  process.stdin.on("data", onData);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (escaped) throw new BackToMenu();
    throw err;
  } finally {
    process.stdin.off("data", onData);
  }
}

export const terminalPrompter: Prompter = {
  select: (message, choices) => select({ message, choices, theme, pageSize: 12, loop: false }),
  input: (message, options) =>
    cancellable((signal) =>
      input({ message: message + BACK_HINT, theme, default: options?.default, validate: options?.validate }, { signal })
    ),
  password: (message) => cancellable((signal) => password({ message: message + BACK_HINT, theme, mask: "•" }, { signal })),
  confirm: (message, defaultValue = false) =>
    cancellable((signal) => confirm({ message: message + BACK_HINT, theme, default: defaultValue }, { signal })),
};

/** True when the error is inquirer reporting that the user pressed Ctrl+C. */
export function isUserCancel(err: unknown): boolean {
  return err instanceof Error && err.name === "ExitPromptError";
}
