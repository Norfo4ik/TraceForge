import { ensureModel, logOnDeviceSummary, shutdownFoundryLocal } from "../core/foundryModel.js";
import { createSession, runTurn } from "../core/agentLoop.js";
import { ToolRegistry } from "../core/toolRegistry.js";
import { createRepoTools, gatherRepoOverview, getRepoRoot } from "../core/repoTools.js";
import { loadConfig } from "../core/config.js";
import { ASK_SYSTEM_PROMPT } from "../prompts/systemPrompts.js";
import { logger } from "../utils/logger.js";

export interface AskOptions {
  verbose?: boolean;
}

export async function runAsk(question: string, opts: AskOptions = {}): Promise<void> {
  const tools = new ToolRegistry();
  let context = "";
  let configuredModel: string | undefined;
  try {
    const repoRoot = getRepoRoot();
    tools.registerAll(createRepoTools(repoRoot));
    configuredModel = loadConfig(repoRoot)?.model;
    // A small model asked "what is this project?" tends to answer "I need more context" instead of reaching for
    // a tool, so hand it the overview up front and keep the tools for details that aren't in it.
    context = `Overview of the repository the user is in (already gathered for you — use the tools only for details not shown here):\n${gatherRepoOverview(repoRoot).text}\n\n---\n`;
  } catch {
    // Not inside a git repo — ask still works, just without repo context or tools.
  }

  const { model, info } = await ensureModel(configuredModel);
  const agent = createSession(model, tools);
  try {
    const startedAt = Date.now();
    const answer = await runTurn(agent, ASK_SYSTEM_PROMPT, `${context}Question: ${question}`, tools, {
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
