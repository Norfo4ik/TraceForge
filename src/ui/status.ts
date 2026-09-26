import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import chalk from "chalk";
import { isNpuProvider } from "../core/accelerators.js";
import { hasAdoCredentials, loadConfig, loadUserSettings, type TraceForgeConfig } from "../core/config.js";
import { getManager, planModel, prepareAccelerators, resolveModelAlias } from "../core/foundryModel.js";
import { getRepoRoot, resolveProject } from "../core/repoTools.js";

export type NpuState = "registered" | "available" | "none" | "unknown";

export interface Status {
  /** The git repository containing the current folder, if any. */
  repoRoot?: string;
  /** What Ask can look at: the git repository, or else the current folder if it looks like a project. */
  projectRoot?: string;
  projectKind?: "git" | "folder";
  branch?: string;
  config?: TraceForgeConfig;
  credentials: boolean;
  email?: string;
  model: string;
  /** e.g. "CPU (CPUExecutionProvider)"; undefined when it couldn't be determined. */
  device?: string;
  /** Set when the usual default model was swapped for one that can use the NPU/GPU. */
  switchedFrom?: string;
  /** The user's saved answer to "use the NPU/GPU?": undefined until they've been asked. */
  acceleratorDecision?: boolean;
  /** Whether the model that will be used is already on disk (undefined when unknown). */
  modelCached?: boolean;
  modelSizeMb?: number;
  npu: NpuState;
}

function currentBranch(repoRoot: string): string | undefined {
  try {
    // symbolic-ref (unlike rev-parse) also works in a repository with no commits yet.
    return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

/** Gathers what the header shows. Never throws: anything unknown is simply left out. */
export async function collectStatus(): Promise<Status> {
  const status: Status = {
    credentials: hasAdoCredentials(),
    email: process.env.ADO_EMAIL,
    model: resolveModelAlias(),
    npu: "unknown",
    acceleratorDecision: loadUserSettings().accelerators,
  };

  const project = resolveProject();
  status.projectRoot = project?.root;
  status.projectKind = project?.kind;

  try {
    status.repoRoot = getRepoRoot();
    status.branch = currentBranch(status.repoRoot);
    status.config = loadConfig(status.repoRoot);
    if (status.config?.model) status.model = resolveModelAlias(status.config.model);
  } catch {
    // not in a git repository (or unreadable config) — the header says so
  }

  try {
    await prepareAccelerators(); // registration is per-process, so it must happen before we look at the state
    const eps = getManager().discoverEps().filter((ep) => isNpuProvider(ep.name));
    status.npu = eps.some((e) => e.isRegistered) ? "registered" : eps.length ? "available" : "none";
    const plan = await planModel(status.config?.model);
    status.device = plan.device;
    status.model = plan.alias;
    status.switchedFrom = plan.switchedFrom;
    status.modelCached = plan.cached;
    status.modelSizeMb = plan.sizeMb;
  } catch {
    // Foundry Local unavailable — shown as unknown
  }
  return status;
}

/** " (2.2 GB)" for the size of a download, or nothing when unknown. */
export function modelSize(status: Pick<Status, "modelSizeMb">): string {
  return status.modelSizeMb ? ` (${(status.modelSizeMb / 1000).toFixed(1)} GB)` : "";
}

export function renderStatus(status: Status, color = true): string {
  const c = {
    label: (t: string) => (color ? chalk.dim(t) : t),
    ok: (t: string) => (color ? chalk.green(t) : t),
    warn: (t: string) => (color ? chalk.yellow(t) : t),
    accent: (t: string) => (color ? chalk.rgb(255, 150, 44)(t) : t),
  };
  const row = (label: string, value: string) => `  ${c.label(label.padEnd(15))}${value}`;

  const repo = status.repoRoot
    ? `${c.accent(basename(status.repoRoot))}${status.branch ? c.label(`  (${status.branch})`) : ""}`
    : status.projectRoot
      ? `${c.accent(basename(status.projectRoot))}  ${c.label("(a folder, not a git repository — Ask works here; Investigate and Docs need git)")}`
      : c.warn("no project here — open TraceForge in a project folder (a git repository to investigate or document it)");

  let ado: string;
  if (!status.config) {
    ado = c.warn(status.repoRoot ? "not set up for this repository — choose “Set up this repository”" : "—");
  } else {
    const who = status.credentials ? c.ok(`✓ signed in${status.email ? ` as ${status.email}` : ""}`) : c.warn("✗ not signed in — choose “Connect Azure DevOps”");
    ado = `${c.accent(`${status.config.organization} / ${status.config.project}`)}  ${who}`;
  }

  const onNpu = status.device?.startsWith("NPU") ?? false;
  const npuText: Record<NpuState, string> = {
    registered: onNpu ? c.ok("running on the NPU") : c.warn("NPU ready, but this model isn't using it"),
    available: c.warn("NPU available, not enabled"),
    none: c.label("no NPU on this machine"),
    unknown: c.label("device unknown"),
  };
  const chosenDevice = status.device?.split(" ")[0] ?? "NPU/GPU";
  const switched = status.switchedFrom ? `\n${" ".repeat(17)}${c.label(`auto-selected: ${status.switchedFrom} has no ${chosenDevice} build here`)}` : "";
  const download = status.modelCached === false ? `  ${c.label("·")}  ${c.warn(`not downloaded yet${modelSize(status)}`)}` : "";
  const ai = `${c.accent(status.model)} ${c.label("on")} ${status.device ?? c.label("…")}  ${c.label("·")}  ${npuText[status.npu]}${download}${switched}`;

  return [row("Repository", repo), row("Azure DevOps", ado), row("On-device AI", ai)].join("\n");
}
