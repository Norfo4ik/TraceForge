#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import dotenv from "dotenv";
import { Command } from "commander";
import { runDoctor } from "./commands/doctor.js";
import { runAsk } from "./commands/ask.js";
import { runInit } from "./commands/init.js";
import { runDocs } from "./commands/docs.js";
import { runInvestigate } from "./commands/investigate.js";
import { runMcpServer } from "./commands/mcp.js";
import { renderLogo } from "./ui/logo.js";
import { runInteractive } from "./ui/menu.js";
import { logger } from "./utils/logger.js";
import { VERSION_LABEL } from "./version.js";

// A .env in the current repo wins; otherwise fall back to a per-user file so credentials are set up once for all repos.
// (dotenv never overrides a variable that is already set, so the order here is the priority.)
dotenv.config({ quiet: true });
dotenv.config({ path: join(homedir(), ".traceforge", ".env"), quiet: true });

const program = new Command();

program
  .name("traceforge")
  .description("TraceForge — trace work items to code with on-device AI. Run with no arguments for the interactive menu.")
  .version(VERSION_LABEL)
  .addHelpText("beforeAll", renderLogo({ columns: process.stdout.columns ?? 80, version: VERSION_LABEL }));

program
  .command("doctor")
  .description("Check the environment: tools, on-device AI (NPU/GPU/CPU), model, and Azure DevOps setup")
  .option("--accelerate", "download and register NPU/GPU execution providers so models can use them")
  .option("--check-ado", "make a real connection to Azure DevOps to verify credentials")
  .action(async (options: { accelerate?: boolean; checkAdo?: boolean }) => {
    await runDoctor(options);
  });

program
  .command("ask <question>")
  .description("Ask the local model a question, with access to repo-inspection tools")
  .option("-v, --verbose", "log tool calls as they happen")
  .action(async (question: string, options: { verbose?: boolean }) => {
    await runAsk(question, options);
  });

program
  .command("init")
  .description("Configure Azure DevOps for this repo and generate first-run documentation")
  .option("--org <organization>", "Azure DevOps organization name")
  .option("--project <project>", "Azure DevOps project name")
  .option("--domains <domains>", "comma-separated MCP tool domains (default: core,work-items,repositories)")
  .option("--model <alias>", "Foundry Local model alias to use")
  .option("--skip-docs", "skip the first-run documentation generation")
  .option("--vscode", "also create VS Code tasks and an MCP registration for Copilot agent mode (never overwrites existing files)")
  .action(async (options: { org?: string; project?: string; domains?: string; model?: string; skipDocs?: boolean; vscode?: boolean }) => {
    await runInit(options);
  });

program
  .command("docs")
  .description("(Re)generate repository documentation into docs/GENERATED_OVERVIEW.md")
  .option("-v, --verbose", "log tool calls as they happen")
  .action(async (options: { verbose?: boolean }) => {
    await runDocs(options);
  });

program
  .command("investigate <workItemId>")
  .description("Investigate an Azure DevOps work item and produce a Markdown report")
  .option("-v, --verbose", "show search terms and details of what the CLI is doing")
  .option("--post-comment", "after saving the report, offer to post it on the work item as a comment (asks first)")
  .option("-y, --yes", "with --post-comment: post without asking (needed when not run in a terminal)")
  .action(async (workItemId: string, options: { verbose?: boolean; postComment?: boolean; yes?: boolean }) => {
    await runInvestigate(workItemId, options);
  });

program
  .command("mcp")
  .description("Serve this repo's read-only tools (list/read/grep files, git log/diff) as an MCP server over stdio")
  .option("--repo <path>", "repository to serve (default: the git repo containing the current directory)")
  .action(async (options: { repo?: string }) => {
    await runMcpServer(options);
  });

// No arguments in a real terminal opens the interactive menu; anything else stays scriptable.
const interactive = process.argv.length <= 2 && process.stdin.isTTY && process.stdout.isTTY;

(interactive ? runInteractive() : program.parseAsync(process.argv)).catch((err: unknown) => {
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
