import ora from "ora";
import { connectAdoMcp, type AdoMcpConnection } from "./adoMcpClient.js";
import { describeWikiFailure, findWikiContext, WIKI_DOMAINS, type WikiExcerpt } from "./adoWiki.js";
import { hasAdoCredentials, loadAdoCredentials, loadConfig, type TraceForgeConfig } from "./config.js";
import { logger } from "../utils/logger.js";

/** Set once the wiki has proved unreadable in this process (e.g. a token without wiki scope), so a menu session says so once. */
let unavailableReported = false;

export function resetWikiNotices(): void {
  unavailableReported = false;
}

/** Whether the wiki should be consulted: Azure DevOps is configured for this project and the user hasn't turned it off. */
export function wikiEnabled(config: TraceForgeConfig | undefined, env: NodeJS.ProcessEnv = process.env): config is TraceForgeConfig {
  if (!config) return false;
  if (/^(0|off|false|no)$/i.test(env.TRACEFORGE_WIKI ?? "")) return false;
  return config.wiki !== false;
}

/**
 * Looks in the wiki with a connection that is already open (Investigate has one), narrating progress and never failing
 * the caller: the wiki is extra context, so any problem becomes a one-line note and an empty result.
 */
export async function lookupWikiWith(ado: AdoMcpConnection, project: string, query: string): Promise<WikiExcerpt[]> {
  if (unavailableReported) return [];
  const spinner = ora("Searching the Azure DevOps wiki…").start();
  try {
    const outcome = await findWikiContext(ado, { project, query });
    if (outcome.status === "found") {
      spinner.succeed(`Found ${outcome.excerpts.length} related wiki page${outcome.excerpts.length === 1 ? "" : "s"}: ${outcome.excerpts.map((e) => e.path).join(", ")}`);
      return outcome.excerpts;
    }
    if (outcome.status === "none") {
      spinner.info("No related wiki pages found");
      return [];
    }
    spinner.warn(describeWikiFailure(outcome));
    unavailableReported = true;
    return [];
  } catch (err) {
    spinner.warn(`Skipped the wiki: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * For commands that don't already talk to Azure DevOps (Ask): opens a short-lived connection, looks the query up in the
 * wiki, closes it. Does nothing — silently — when the project has no Azure DevOps setup or credentials.
 */
export async function lookupWiki(projectRoot: string | undefined, query: string, opts: { verbose?: boolean } = {}): Promise<WikiExcerpt[]> {
  if (!projectRoot || unavailableReported) return [];
  let config: TraceForgeConfig | undefined;
  try {
    config = loadConfig(projectRoot);
  } catch {
    return [];
  }
  if (!wikiEnabled(config) || !hasAdoCredentials()) return [];

  const creds = loadAdoCredentials();
  let ado: AdoMcpConnection | undefined;
  const connecting = ora("Connecting to the Azure DevOps wiki…").start();
  try {
    ado = await connectAdoMcp({ organization: config.organization, domains: WIKI_DOMAINS, email: creds.email, pat: creds.pat, verbose: opts.verbose });
    connecting.stop();
  } catch (err) {
    connecting.warn(`Could not reach Azure DevOps, answering without the wiki: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  try {
    return await lookupWikiWith(ado, config.project, query);
  } finally {
    await ado.close().catch(() => {});
  }
}

/** Prints where each wiki excerpt came from, for --verbose. */
export function logWikiSources(excerpts: WikiExcerpt[]): void {
  for (const e of excerpts) logger.info(`  wiki: ${e.wiki} ${e.path} (${e.text.length} characters)`);
}
