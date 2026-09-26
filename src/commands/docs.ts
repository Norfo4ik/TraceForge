import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ora from "ora";
import { contextWindow, ensureModel, logOnDeviceSummary, rememberContextWindow, shutdownFoundryLocal } from "../core/foundryModel.js";
import { runWithContextRetry } from "../core/contextRetry.js";
import { createSession, runTurn } from "../core/agentLoop.js";
import { ToolRegistry } from "../core/toolRegistry.js";
import { gatherRepoOverview, getRepoRoot } from "../core/repoTools.js";
import { loadConfig } from "../core/config.js";
import { inputCharBudget, outputTokenBudget } from "../core/contextBudget.js";
import { DOCS_SYSTEM_PROMPT } from "../prompts/systemPrompts.js";
import { logger } from "../utils/logger.js";

export interface DocsOptions {
  verbose?: boolean;
}

/**
 * Reads the repo itself (file list, manifests/README/entry point, recent commits) and hands the model
 * that evidence to write from — a small local model summarizes real data far more faithfully than it
 * explores a repo on its own, where it tends to invent plausible-looking files.
 */
export async function runDocs(opts: DocsOptions = {}): Promise<string> {
  const repoRoot = getRepoRoot();
  const config = loadConfig(repoRoot);

  // The model is loaded first because its context window decides how much of the repository fits in the prompt.
  const { model, info, alias } = await ensureModel(config?.model);
  const framing = "\n\nWrite the onboarding documentation now.";

  try {
    const startedAt = Date.now();
    const doc = await runWithContextRetry(
      { known: contextWindow(model, info, alias), remember: (n) => rememberContextWindow(alias, n) },
      async (contextLength) => {
        const budget = inputCharBudget(contextLength, outputTokenBudget(contextLength), DOCS_SYSTEM_PROMPT.length + framing.length);
        const reading = ora("Reading the repository…").start();
        const overview = gatherRepoOverview(repoRoot, "git", { maxChars: budget });
        reading.succeed(`Read ${overview.fileCount} tracked files, key manifests and recent history`);
        if (opts.verbose) {
          logger.info(`  context window: ${contextLength ?? "unknown"} tokens; prompt material: ${overview.text.length} characters`);
        }

        const agent = createSession(model, undefined, { contextLength });
        try {
          return await runTurn(agent, DOCS_SYSTEM_PROMPT, `${overview.text}${framing}`, new ToolRegistry(), {
            verbose: opts.verbose,
            statusLabel: "Writing documentation",
            disableThinking: true,
            requireHeading: true,
          });
        } finally {
          agent.session.dispose();
        }
      }
    );

    const docsDir = join(repoRoot, "docs");
    mkdirSync(docsDir, { recursive: true });
    const outPath = join(docsDir, "GENERATED_OVERVIEW.md");
    writeFileSync(outPath, doc.trim() + "\n", "utf-8");
    logger.ok(`Documentation written to ${outPath}`);
    logOnDeviceSummary(info, startedAt);
    return outPath;
  } finally {
    shutdownFoundryLocal();
  }
}
