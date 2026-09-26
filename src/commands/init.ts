import { getRepoRoot } from "../core/repoTools.js";
import { ensureGitignored } from "../core/gitignore.js";
import { writeVscodeFiles } from "../core/vscode.js";
import { loadConfig, saveConfig, type TraceForgeConfig } from "../core/config.js";
import { runDocs } from "./docs.js";
import { logger } from "../utils/logger.js";

export interface InitOptions {
  org?: string;
  project?: string;
  domains?: string;
  model?: string;
  skipDocs?: boolean;
  vscode?: boolean;
}

const DEFAULT_DOMAINS = ["core", "work-items", "repositories"];

export async function runInit(opts: InitOptions): Promise<void> {
  const repoRoot = getRepoRoot();
  logger.heading(`Initializing TraceForge in ${repoRoot}`);

  const existing = loadConfig(repoRoot);
  const organization = opts.org ?? existing?.organization;
  const project = opts.project ?? existing?.project;

  if (!organization || !project) {
    throw new Error(
      'Azure DevOps org/project not configured. Re-run with --org <org> --project <project>, e.g.\n  traceforge init --org contoso --project MyProject'
    );
  }

  const domains = opts.domains ? opts.domains.split(",").map((d) => d.trim()) : existing?.domains ?? DEFAULT_DOMAINS;

  const config: TraceForgeConfig = {
    organization,
    project,
    domains,
    model: opts.model ?? existing?.model,
  };
  saveConfig(repoRoot, config);
  logger.ok("Saved configuration to .traceforge/config.json");

  const added = ensureGitignored(repoRoot, [".traceforge/", ".env"]);
  if (added.length) {
    logger.ok(`Added ${added.join(", ")} to .gitignore (reports and any local .env stay out of git)`);
  }

  if (opts.vscode) {
    const { created, skipped } = writeVscodeFiles(repoRoot);
    if (created.length) logger.ok(`Created ${created.join(", ")} (Terminal ▸ Run Task ▸ "TraceForge: …")`);
    if (skipped.length) logger.info(`Left your existing ${skipped.join(", ")} untouched.`);
  }

  if (!opts.skipDocs) {
    logger.heading("Generating repository documentation (first run)");
    await runDocs();
  }

  logger.heading("Setup complete");
  logger.info("Try: traceforge investigate <work-item-id>");
}
