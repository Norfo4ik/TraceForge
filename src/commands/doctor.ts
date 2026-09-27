import { execFileSync, execSync } from "node:child_process";
import ora from "ora";
import { isNpuProvider } from "../core/accelerators.js";
import { connectAdoMcp } from "../core/adoMcpClient.js";
import { checkWikiAccess, describeWikiFailure, WIKI_DOMAINS } from "../core/adoWiki.js";
import { loadConfig, saveUserSettings } from "../core/config.js";
import {
  acceleratedModels,
  blockedBuildIds,
  catalogReport,
  clearBlockedBuilds,
  getManager,
  planModel,
  prepareAccelerators,
  registerAccelerators,
  shutdownFoundryLocal,
} from "../core/foundryModel.js";
import { getRepoRoot } from "../core/repoTools.js";
import { logger } from "../utils/logger.js";

export interface DoctorOptions {
  /** Download and register NPU/GPU execution providers so models can run on them. */
  accelerate?: boolean;
  /** Make a real connection to Azure DevOps to verify the credentials. */
  checkAdo?: boolean;
}

function checkTools(): void {
  logger.info(`Node.js ${process.version}`);
  try {
    logger.ok(execFileSync("git", ["--version"], { encoding: "utf-8" }).trim());
  } catch {
    logger.error("git not found on PATH — required to inspect repo history and search code.");
  }
  // On Windows npx is npx.cmd, which spawnSync can't exec directly (EINVAL) — execSync goes through a shell.
  try {
    logger.ok(`npx ${execSync("npx --version", { encoding: "utf-8" }).trim()} (launches the Azure DevOps MCP server)`);
  } catch {
    logger.error("npx not found on PATH — required to run the Azure DevOps MCP server.");
  }
}

async function checkAccelerators(accelerate: boolean): Promise<void> {
  const manager = getManager();
  logger.ok("Foundry Local runtime loaded");

  await prepareAccelerators(); // no-op unless the user opted in earlier; registration doesn't persist across runs
  let eps = manager.discoverEps();
  if (accelerate) {
    const forgiven = blockedBuildIds().length;
    if (forgiven > 0) {
      clearBlockedBuilds();
      logger.info(`Cleared ${forgiven} build(s) that failed to load earlier — they will be tried again.`);
    }
    const pending = eps.filter((ep) => !ep.isRegistered);
    let registrationFailed = false;
    if (pending.length === 0) {
      logger.info("Every available execution provider is already registered.");
    } else {
      const spinner = ora(`Downloading and registering: ${pending.map((p) => p.name).join(", ")}…`).start();
      try {
        const result = await registerAccelerators((name, pct) => {
          spinner.text = `Registering ${name}… ${Math.round(pct)}%`;
        });
        if (result.failed.length) {
          spinner.warn(`Registered ${result.registered.join(", ") || "nothing"}; failed: ${result.failed.join(", ")}`);
        } else {
          spinner.succeed(`Registered: ${result.registered.join(", ") || "nothing new"}`);
        }
      } catch (err) {
        registrationFailed = true;
        spinner.fail(`Could not register execution providers: ${(err as Error).message}`);
      }
      eps = manager.discoverEps();
    }
    if (!registrationFailed) {
      // Registration only lasts for this process, so remember the opt-in and repeat it at every start.
      saveUserSettings({ accelerators: true });
      logger.ok("Saved: TraceForge will enable these automatically each time it starts (set TRACEFORGE_ACCELERATE=off to skip).");
    }
  }

  if (eps.length === 0) logger.info("No optional execution providers reported; models will run on CPU.");
  for (const ep of eps) {
    logger.info(`  execution provider: ${ep.name} (${ep.isRegistered ? "registered" : "available, not registered"})`);
  }

  const npu = eps.filter((ep) => isNpuProvider(ep.name));
  if (npu.some((ep) => ep.isRegistered)) {
    logger.ok("An NPU execution provider is registered — models can run on the NPU.");
  } else if (npu.length) {
    logger.warn('An NPU is available but not registered. Run "traceforge doctor --accelerate" to enable it.');
  } else {
    logger.warn("No NPU detected on this machine — inference runs on CPU/GPU. Re-run on a Copilot+ PC for NPU acceleration.");
  }
  if (!accelerate && eps.some((ep) => !ep.isRegistered)) {
    logger.info('  (Run "traceforge doctor --accelerate" to download and register the providers above.)');
  }
}

async function checkModel(alias?: string): Promise<void> {
  try {
    const plan = await planModel(alias);
    logger.ok(`Model "${plan.alias}" will run on ${plan.device}${plan.cached ? "" : " (not downloaded yet — downloads on first use)"}`);
    if (plan.switchedFrom) {
      logger.info(
        `  Auto-selected: ${plan.switchedFrom} (the usual default) has no NPU/GPU build here. ` +
          `Set TRACEFORGE_MODEL to choose a model yourself, or TRACEFORGE_DEVICE=cpu to stay on the CPU.`
      );
    }

    const skipped = blockedBuildIds();
    if (skipped.length > 0) {
      logger.warn(
        `  Skipping ${skipped.length} build(s) that failed to load earlier: ${skipped.join(", ")}. ` +
          `After fixing the cause (for an NPU: update the Intel NPU driver), choose "Enable NPU / GPU acceleration" to try again.`
      );
    }

    const report = await catalogReport();
    for (const provider of report.unused) {
      logger.warn(
        `  ${provider} is registered, but no model in the catalog uses it — the catalog may not have picked up the registration. ` +
          `Restart TraceForge; if this persists, run "traceforge doctor --accelerate" and send the output.`
      );
    }
    if (report.builds.length) {
      logger.info("  NPU/GPU builds in the catalog, per runtime:");
      for (const line of report.builds) logger.info(`    ${line}`);
    }

    const accelerated = await acceleratedModels();
    if (accelerated.length === 0) {
      logger.info("  No models in the catalog have an NPU/GPU build that this machine can run.");
      return;
    }
    const byAlias = new Map<string, string[]>();
    for (const v of accelerated) {
      const entry = `${v.deviceType}${v.fileSizeMb ? ` ${(v.fileSizeMb / 1000).toFixed(1)}GB` : ""}${v.supportsToolCalling ? ", tools" : ""}`;
      byAlias.set(v.alias, [...(byAlias.get(v.alias) ?? []), entry]);
    }
    logger.info(`  Models with an NPU/GPU build on this machine (${byAlias.size}):`);
    for (const [name, entries] of byAlias) logger.info(`    ${name}  [${entries.join(" | ")}]`);
  } catch (err) {
    logger.error(`Model lookup failed: ${(err as Error).message}`);
  }
}

async function checkAzureDevOps(checkLive: boolean): Promise<void> {
  let repoRoot: string;
  try {
    repoRoot = getRepoRoot();
  } catch {
    logger.info("Not inside a git repository — skipping Azure DevOps checks.");
    return;
  }

  const config = loadConfig(repoRoot);
  if (config) {
    logger.ok(`Azure DevOps: ${config.organization}/${config.project}`);
  } else {
    logger.warn('No Azure DevOps configuration here. Run "traceforge init --org <org> --project <project>".');
  }

  const email = process.env.ADO_EMAIL;
  const pat = process.env.ADO_PAT;
  if (email && pat) {
    logger.ok(`Credentials found for ${email} (PAT set, not shown)`);
  } else {
    logger.warn(
      `Missing ${[!email && "ADO_EMAIL", !pat && "ADO_PAT"].filter(Boolean).join(" and ")} — put them in a .env in this repo or in ~/.traceforge/.env.`
    );
  }

  if (checkLive && config && email && pat) {
    const spinner = ora("Connecting to Azure DevOps…").start();
    try {
      const ado = await connectAdoMcp({ organization: config.organization, domains: ["work-items", ...WIKI_DOMAINS], email, pat });
      spinner.succeed("Connected to Azure DevOps");
      try {
        const wiki = await checkWikiAccess(ado, config.project);
        if (wiki.ok && wiki.wikis.length > 0) {
          logger.ok(`Wiki: ${wiki.wikis.length} wiki${wiki.wikis.length === 1 ? "" : "s"} readable (${wiki.wikis.slice(0, 3).join(", ")})`);
        } else if (wiki.ok) {
          logger.info(`Wiki: readable, but project "${config.project}" has no wiki yet — Ask and Investigate will skip it.`);
        } else {
          logger.warn(`Wiki: ${describeWikiFailure({ status: "unavailable", reason: wiki.reason, detail: wiki.detail })}`);
        }
      } finally {
        await ado.close();
      }
    } catch (err) {
      spinner.fail(`Could not connect: ${(err as Error).message}`);
    }
  } else if (checkLive) {
    logger.info("Skipping the live Azure DevOps check until configuration and credentials are present.");
  }
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  try {
    logger.heading("Environment");
    checkTools();

    logger.heading("On-device AI");
    try {
      await checkAccelerators(opts.accelerate === true);
    } catch (err) {
      logger.error(`Foundry Local failed to initialize: ${(err as Error).message}`);
    }
    await checkModel(loadConfigModel());

    logger.heading("Azure DevOps");
    await checkAzureDevOps(opts.checkAdo === true);
  } finally {
    shutdownFoundryLocal();
  }
}

function loadConfigModel(): string | undefined {
  try {
    return loadConfig(getRepoRoot())?.model;
  } catch {
    return undefined;
  }
}
