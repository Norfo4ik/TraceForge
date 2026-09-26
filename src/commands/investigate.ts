import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ora from "ora";
import {
  contextWindow,
  describeDevice,
  ensureModel,
  logOnDeviceSummary,
  rememberContextWindow,
  shutdownFoundryLocal,
} from "../core/foundryModel.js";
import { runWithContextRetry } from "../core/contextRetry.js";
import { createSession, runTurn } from "../core/agentLoop.js";
import { ToolRegistry } from "../core/toolRegistry.js";
import { gatherRepoOverview, getRepoRoot, searchRepoForTerms } from "../core/repoTools.js";
import { connectAdoMcp, type AdoMcpConnection } from "../core/adoMcpClient.js";
import { extractSearchTerms, fetchWorkItemBrief, formatCommentBody, postWorkItemComment } from "../core/adoWorkItem.js";
import { loadConfig, loadAdoCredentials } from "../core/config.js";
import { inputCharBudget, outputTokenBudget, truncateText } from "../core/contextBudget.js";
import { INVESTIGATE_SYSTEM_PROMPT } from "../prompts/systemPrompts.js";
import { logger } from "../utils/logger.js";
import { confirm } from "../utils/prompt.js";

export interface InvestigateOptions {
  verbose?: boolean;
  /** After saving the report, offer to post it back to the work item as a comment. */
  postComment?: boolean;
  /** Skip the confirmation prompt for --post-comment (required when there is no terminal). */
  yes?: boolean;
}

/**
 * The CLI gathers the evidence itself (work item via the Azure DevOps MCP server, related code via
 * git grep) and hands the model a compact, real dataset to write the report from. A small local model
 * is far more reliable at "summarize this" than at choosing among two dozen tools, and the model itself
 * never gets access to Azure DevOps write tools: the only write is the CLI's own, explicit --post-comment.
 */
export async function runInvestigate(workItemId: string, opts: InvestigateOptions = {}): Promise<void> {
  const repoRoot = getRepoRoot();
  const config = loadConfig(repoRoot);
  if (!config) {
    throw new Error('No Azure DevOps configuration found. Run "traceforge init --org <org> --project <project>" first.');
  }
  const creds = loadAdoCredentials();

  let ado: AdoMcpConnection | undefined;
  let agent: ReturnType<typeof createSession> | undefined;
  try {
    const connecting = ora(`Connecting to Azure DevOps (${config.organization})…`).start();
    try {
      ado = await connectAdoMcp({
        organization: config.organization,
        domains: ["work-items"],
        email: creds.email,
        pat: creds.pat,
        verbose: opts.verbose,
      });
      connecting.succeed(`Connected to Azure DevOps (${config.organization})`);
    } catch (err) {
      connecting.fail("Could not connect to Azure DevOps");
      throw err;
    }

    const fetching = ora(`Fetching work item #${workItemId}…`).start();
    let brief;
    try {
      brief = await fetchWorkItemBrief(ado, config.project, workItemId);
      fetching.succeed(`Fetched ${brief.type} #${brief.id}: ${brief.title} [${brief.state}]`);
    } catch (err) {
      fetching.fail(`Could not fetch work item #${workItemId}`);
      throw err;
    }
    // Only keep the connection open if we'll need it again to post the comment.
    if (!opts.postComment) {
      await ado.close();
      ado = undefined;
    }

    const searching = ora("Searching the repository for related code…").start();
    const terms = extractSearchTerms(brief.searchableText);
    const hits = searchRepoForTerms(repoRoot, terms);
    searching.succeed(
      hits.length
        ? `Found code references for: ${hits.map((h) => h.term).join(", ")}`
        : "No obvious code references found for this work item"
    );
    if (opts.verbose) {
      logger.info(`  search terms: ${terms.join(", ") || "(none)"}`);
    }

    const hitsText = hits.length
      ? hits.map((h) => `Term "${h.term}":\n${h.matches.map((m) => `  ${m}`).join("\n")}`).join("\n")
      : "(no matches)";
    // The model is loaded first because its context window decides how much of each part fits in the prompt. The work item
    // and the search hits get bounded shares; the repository overview takes whatever is left.
    const { model, info, alias } = await ensureModel(config.model);
    const hitsHeading = "\n\n---\nKeyword search of the repository (terms taken from the work item; matches can be coincidental):\n";
    const overviewHeading = "\n\n---\nRepository overview:\n";
    const closing = "\n\nWrite the investigation report now.";
    const buildMessage = (contextLength: number | undefined): string => {
      const available = inputCharBudget(
        contextLength,
        outputTokenBudget(contextLength),
        INVESTIGATE_SYSTEM_PROMPT.length + hitsHeading.length + overviewHeading.length + closing.length
      );
      const briefText = truncateText(brief.text, Math.floor(available * 0.4));
      const hitsShown = truncateText(hitsText, Math.floor(available * 0.2));
      const overview = gatherRepoOverview(repoRoot, "git", { maxChars: Math.max(0, available - briefText.length - hitsShown.length) });
      if (opts.verbose) {
        logger.info(`  context window: ${contextLength ?? "unknown"} tokens; work item ${briefText.length}, search ${hitsShown.length}, overview ${overview.text.length} characters`);
      }
      return `${briefText}${hitsHeading}${hitsShown}${overviewHeading}${overview.text}${closing}`;
    };

    const startedAt = Date.now();
    const report = await runWithContextRetry(
      { known: contextWindow(model, info, alias), remember: (n) => rememberContextWindow(alias, n) },
      async (contextLength) => {
        agent = createSession(model, undefined, { contextLength });
        try {
          return await runTurn(agent, INVESTIGATE_SYSTEM_PROMPT, buildMessage(contextLength), new ToolRegistry(), {
            verbose: opts.verbose,
            statusLabel: `Analyzing ${brief.type} #${brief.id}`,
            disableThinking: true,
            requireHeading: true,
          });
        } finally {
          agent.session.dispose();
        }
      }
    );

    const document = `# Investigation: ${brief.type} #${brief.id} — ${brief.title}\n\n${report.trim()}\n`;
    console.log("\n" + document);

    const outDir = join(repoRoot, ".traceforge", "investigations");
    mkdirSync(outDir, { recursive: true });
    const outPath = join(outDir, `${workItemId}.md`);
    writeFileSync(outPath, document, "utf-8");
    logger.ok(`Saved report to ${outPath}`);
    logOnDeviceSummary(info, startedAt);

    if (opts.postComment && ado) {
      const comment = formatCommentBody(report, `${alias} on ${describeDevice(info)}`);
      const target = `${brief.type} #${brief.id} in ${config.organization}/${config.project}`;
      let approved = opts.yes === true;
      if (!approved) {
        const lines = comment.split("\n");
        logger.heading(`Comment to post on ${target}`);
        console.log(lines.slice(0, 14).join("\n") + (lines.length > 14 ? "\n…" : ""));
        approved = await confirm(`\nPost this comment on ${target}?`);
      }

      if (!approved) {
        logger.info(
          process.stdin.isTTY
            ? "Comment not posted."
            : "Comment not posted: no terminal to confirm on — pass --yes to post non-interactively."
        );
      } else {
        const posting = ora(`Posting comment to ${target}…`).start();
        try {
          await postWorkItemComment(ado, config.project, workItemId, comment);
          posting.succeed(`Comment posted on ${target}`);
        } catch (err) {
          posting.fail("Could not post the comment");
          throw err;
        }
      }
    }
  } finally {
    agent?.session.dispose();
    shutdownFoundryLocal();
    await ado?.close();
  }
}
