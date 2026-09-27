import ora from "ora";
import { connectAdoMcp, type AdoMcpConnection } from "../core/adoMcpClient.js";
import { describeWikiFailure, findWikiContext, WIKI_DOMAINS } from "../core/adoWiki.js";
import { loadAdoCredentials, loadConfig } from "../core/config.js";
import { resolveProject } from "../core/repoTools.js";
import { logger } from "../utils/logger.js";

export interface WikiOptions {
  verbose?: boolean;
}

/**
 * Shows which wiki pages TraceForge would hand the model for a question — no model involved. It is the way to check
 * what Ask and Investigate see in the wiki, and whether the token can read it at all.
 */
export async function runWiki(query: string, opts: WikiOptions = {}): Promise<void> {
  const project = resolveProject();
  const config = project ? loadConfig(project.root) : undefined;
  if (!config) {
    throw new Error('No Azure DevOps configuration found here. Run "traceforge init --org <org> --project <project>" first.');
  }
  const creds = loadAdoCredentials();

  let ado: AdoMcpConnection | undefined;
  const spinner = ora(`Searching the ${config.organization}/${config.project} wiki…`).start();
  try {
    ado = await connectAdoMcp({ organization: config.organization, domains: WIKI_DOMAINS, email: creds.email, pat: creds.pat, verbose: opts.verbose });
    const outcome = await findWikiContext(ado, { project: config.project, query, maxPages: 5, pageChars: 1500 });
    if (outcome.status === "unavailable") {
      spinner.fail("Could not read the wiki");
      logger.warn(describeWikiFailure(outcome));
      process.exitCode = 1;
      return;
    }
    if (outcome.status === "none") {
      if (outcome.emptyPages?.length) {
        spinner.info(`Matched ${outcome.emptyPages.join(", ")}, but the page has no text yet`);
      } else {
        spinner.info(`No matching wiki pages${outcome.terms.length ? ` (searched for: ${outcome.terms.join(", ")})` : " — the query has no searchable words"}`);
      }
      return;
    }
    spinner.succeed(`Found ${outcome.excerpts.length} page${outcome.excerpts.length === 1 ? "" : "s"} (searched for: ${outcome.terms.join(", ")})`);
    for (const e of outcome.excerpts) {
      logger.heading(`${e.wiki} ${e.path}`);
      console.log(e.text);
    }
  } catch (err) {
    spinner.fail("Wiki search failed");
    throw err;
  } finally {
    await ado?.close();
  }
}
