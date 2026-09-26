import { contextWindow, ensureModel, logOnDeviceSummary, rememberContextWindow, shutdownFoundryLocal } from "../core/foundryModel.js";
import { runWithContextRetry } from "../core/contextRetry.js";
import { createSession, runTurn } from "../core/agentLoop.js";
import { ToolRegistry } from "../core/toolRegistry.js";
import { createRepoTools, gatherRepoOverview, resolveProject } from "../core/repoTools.js";
import { loadConfig } from "../core/config.js";
import { inputCharBudget, outputTokenBudget, toolDefinitionChars } from "../core/contextBudget.js";
import { formatWikiForPrompt } from "../core/adoWiki.js";
import { logWikiSources, lookupWiki } from "../core/wikiContext.js";
import { ASK_SYSTEM_PROMPT, NO_REPOSITORY_NOTE } from "../prompts/systemPrompts.js";
import { logger } from "../utils/logger.js";

export interface AskOptions {
  verbose?: boolean;
}

/** How much wiki text goes in the prompt when the model's window is unknown. */
const UNBOUNDED_WIKI_CHARS = 12_000;

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
  let configuredModel: string | undefined;
  // A git repository, or else a plain folder that looks like a project (files only, no history).
  const project = resolveProject();
  if (project) {
    tools.registerAll(createRepoTools(project.root, project.kind));
    configuredModel = loadConfig(project.root)?.model;
  } else {
    logger.warn("No project found here (not a git repository, and this folder has no source files) — I can only answer general questions.");
  }

  // Team documentation first: it's a quick lookup, and a token problem should show before a slow model load.
  const wikiPages = await lookupWiki(project?.root, question, { verbose: opts.verbose });
  if (opts.verbose) logWikiSources(wikiPages);

  // The model is loaded next because its context window decides how much of the project overview fits.
  const { model, info, alias } = await ensureModel(configuredModel);
  const asked = clarifyBroadQuestion(question);

  const buildContext = (contextLength: number | undefined): string => {
    if (!project) {
      // Nothing to look at: ask still works for general questions, but the model must be told it is blind. Without
      // this it invents a plausible project (file lists, commits, even work-item numbers) to answer "what about this repo?".
      return `${NO_REPOSITORY_NOTE}\n\n---\n`;
    }
    const where = project.kind === "git" ? "repository" : "project folder (it is not a git repository, so there is no commit history)";
    const heading = `Overview of the ${where} the user is in (already gathered for you — use the tools only for details not shown here):\n`;
    const tail = "\n\n---\n";
    const fixedChars = ASK_SYSTEM_PROMPT.length + toolDefinitionChars(tools.definitions()) + heading.length + tail.length * 2 + asked.length + 20;
    const budget = inputCharBudget(contextLength, outputTokenBudget(contextLength), fixedChars);
    // Wiki pages get up to 40% of what the window leaves; the overview takes the rest. Unknown window: no squeeze.
    const wiki = formatWikiForPrompt(wikiPages, Number.isFinite(budget) ? Math.floor(budget * 0.4) : UNBOUNDED_WIKI_CHARS);
    const overview = gatherRepoOverview(project.root, project.kind, { maxChars: budget - wiki.length }).text;
    if (opts.verbose) {
      logger.info(`  context window: ${contextLength ?? "unknown"} tokens; overview trimmed to ${overview.length} characters, wiki ${wiki.length}`);
    }
    // A small model asked "what is this project?" tends to answer "I need more context" instead of reaching for
    // a tool, so hand it the overview up front and keep the tools for details that aren't in it.
    return `${heading}${overview}${tail}${wiki ? `${wiki}${tail}` : ""}`;
  };

  try {
    const startedAt = Date.now();
    const answer = await runWithContextRetry(
      { known: contextWindow(model, info, alias), remember: (n) => rememberContextWindow(alias, n) },
      async (contextLength) => {
        const agent = createSession(model, tools, { contextLength });
        try {
          return await runTurn(agent, ASK_SYSTEM_PROMPT, `${buildContext(contextLength)}Question: ${asked}`, tools, {
            verbose: opts.verbose,
            statusLabel: "Thinking",
            disableThinking: true,
          });
        } finally {
          agent.session.dispose();
        }
      }
    );

    if (!answer.trim()) {
      logger.warn("Model returned no text output.");
      return;
    }

    console.log("\n" + answer.trim() + "\n");
    logOnDeviceSummary(info, startedAt);
  } finally {
    shutdownFoundryLocal();
  }
}
