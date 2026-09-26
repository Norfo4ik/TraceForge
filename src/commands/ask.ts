import { ensureModel, logOnDeviceSummary, shutdownFoundryLocal } from "../core/foundryModel.js";
import { createSession, runTurn } from "../core/agentLoop.js";
import { ToolRegistry } from "../core/toolRegistry.js";
import { createRepoTools, gatherRepoOverview, resolveProject } from "../core/repoTools.js";
import { loadConfig } from "../core/config.js";
import { ASK_SYSTEM_PROMPT, NO_REPOSITORY_NOTE } from "../prompts/systemPrompts.js";
import { logger } from "../utils/logger.js";

export interface AskOptions {
  verbose?: boolean;
}

const SUMMARY_REQUEST =
  "(Answer with a short summary of the project taken from the overview above: what it is, its main folders and files, and how to build or run it. Do not ask what I want to know.)";

/**
 * A short question about the repository as a whole ("what about this repo?") makes a small model reply "let me know
 * what you'd like to know", even with the overview in front of it — and a system-prompt rule didn't change that. So
 * spell out the request in the user's own message. Anything that names something specific (a file, a quoted term,
 * an identifier) is left alone.
 */
export function clarifyBroadQuestion(question: string): string {
  const text = question.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const aboutWholeRepo = /\b(repo|repository|project|codebase|this code)\b/i.test(text);
  const namesSomethingSpecific = /["'`]|\b[\w-]+\.\w{1,5}\b|[a-z]+[A-Z]\w+|\w+_\w+|\//.test(text);
  if (words.length === 0 || words.length > 8 || !aboutWholeRepo || namesSomethingSpecific) return text;
  return `${text}\n\n${SUMMARY_REQUEST}`;
}

export async function runAsk(question: string, opts: AskOptions = {}): Promise<void> {
  const tools = new ToolRegistry();
  let context = "";
  let configuredModel: string | undefined;
  // A git repository, or else a plain folder that looks like a project (files only, no history).
  const project = resolveProject();
  if (project) {
    tools.registerAll(createRepoTools(project.root, project.kind));
    configuredModel = loadConfig(project.root)?.model;
    const where = project.kind === "git" ? "repository" : "project folder (it is not a git repository, so there is no commit history)";
    // A small model asked "what is this project?" tends to answer "I need more context" instead of reaching for
    // a tool, so hand it the overview up front and keep the tools for details that aren't in it.
    context = `Overview of the ${where} the user is in (already gathered for you — use the tools only for details not shown here):\n${gatherRepoOverview(project.root, project.kind).text}\n\n---\n`;
  } else {
    // Nothing to look at: ask still works for general questions, but the model must be told it is blind. Without
    // this it invents a plausible project (file lists, commits, even work-item numbers) to answer "what about this repo?".
    logger.warn("No project found here (not a git repository, and this folder has no source files) — I can only answer general questions.");
    context = `${NO_REPOSITORY_NOTE}\n\n---\n`;
  }

  const { model, info } = await ensureModel(configuredModel);
  const agent = createSession(model, tools);
  try {
    const startedAt = Date.now();
    const answer = await runTurn(agent, ASK_SYSTEM_PROMPT, `${context}Question: ${clarifyBroadQuestion(question)}`, tools, {
      verbose: opts.verbose,
      statusLabel: "Thinking",
      disableThinking: true,
    });

    if (!answer.trim()) {
      logger.warn("Model returned no text output.");
      return;
    }

    console.log("\n" + answer.trim() + "\n");
    logOnDeviceSummary(info, startedAt);
  } finally {
    agent.session.dispose();
    shutdownFoundryLocal();
  }
}
