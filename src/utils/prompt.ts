import { BackToMenu, terminalPrompter } from "../ui/prompter.js";

/**
 * Asks a yes/no question. Defaults to "no", to "no" when Esc is pressed, and to "no" outright when there is
 * no terminal to answer on.
 */
export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  try {
    return await terminalPrompter.confirm(question, false);
  } catch (err) {
    if (err instanceof BackToMenu) return false;
    throw err;
  }
}
