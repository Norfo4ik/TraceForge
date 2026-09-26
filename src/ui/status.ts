import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import chalk from "chalk";
import { isNpuProvider } from "../core/accelerators.js";
import { hasAdoCredentials, loadConfig, type TraceForgeConfig } from "../core/config.js";
import { getManager, planModel, resolveModelAlias } from "../core/foundryModel.js";
import { getRepoRoot } from "../core/repoTools.js";

export type NpuState = "registered" | "available" | "none" | "unknown";

export interface Status {
  repoRoot?: string;
  branch?: string;
  config?: TraceForgeConfig;
  credentials: boolean;
  email?: string;
  model: string;
  /** e.g. "CPU (CPUExecutionProvider)"; undefined when it couldn't be determined. */
  device?: string;
  /** Set when the usual default model was swapped for one that can use the NPU/GPU. */
  switchedFrom?: string;
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
  const status: Status = { credentials: hasAdoCredentials(), email: process.env.ADO_EMAIL, model: resolveModelAlias(), npu: "unknown" };

  try {
    status.repoRoot = getRepoRoot();
    status.branch = currentBranch(status.repoRoot);
    status.config = loadConfig(status.repoRoot);
    if (status.config?.model) status.model = resolveModelAlias(status.config.model);
  } catch {
    // not in a git repository (or unreadable config) — the header says so
  }

  try {
    const eps = getManager().discoverEps().filter((ep) => isNpuProvider(ep.name));
    status.npu = eps.some((e) => e.isRegistered) ? "registered" : eps.length ? "available" : "none";
    const plan = await planModel(status.config?.model);
    status.device = plan.device;
    status.model = plan.alias;
    status.switchedFrom = plan.switchedFrom;
  } catch {
    // Foundry Local unavailable — shown as unknown
  }
  return status;
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
    : c.warn("not inside a git repository — open TraceForge in one to investigate or document it");

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
  const switched = status.switchedFrom ? `\n${" ".repeat(17)}${c.label(`auto-selected: ${status.switchedFrom} has no NPU/GPU build here`)}` : "";
  const ai = `${c.accent(status.model)} ${c.label("on")} ${status.device ?? c.label("…")}  ${c.label("·")}  ${npuText[status.npu]}${switched}`;

  return [row("Repository", repo), row("Azure DevOps", ado), row("On-device AI", ai)].join("\n");
}
