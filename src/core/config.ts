import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  organization: z.string(),
  project: z.string(),
  domains: z.array(z.string()).default(["core", "work-items", "repositories"]),
  model: z.string().optional(),
});

export type TraceForgeConfig = z.infer<typeof ConfigSchema>;

function configDir(repoRoot: string): string {
  return join(repoRoot, ".traceforge");
}

function configPath(repoRoot: string): string {
  return join(configDir(repoRoot), "config.json");
}

export function loadConfig(repoRoot: string): TraceForgeConfig | undefined {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return undefined;
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return ConfigSchema.parse(raw);
}

export function saveConfig(repoRoot: string, config: TraceForgeConfig): void {
  mkdirSync(configDir(repoRoot), { recursive: true });
  writeFileSync(configPath(repoRoot), JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function userConfigDir(): string {
  return join(homedir(), ".traceforge");
}

/**
 * Saves Azure DevOps credentials to the per-user env file (~/.traceforge/.env), which every repo falls back to,
 * replacing only the two ADO_* lines and keeping anything else already in the file. Plain text, like any .env —
 * it lives in the user's home folder, never inside a repo.
 */
export function saveUserCredentials(email: string, pat: string, dir: string = userConfigDir()): string {
  if (/[\r\n]/.test(email + pat)) throw new Error("Credentials must not contain line breaks.");
  const path = join(dir, ".env");
  mkdirSync(dir, { recursive: true });
  const kept = existsSync(path)
    ? readFileSync(path, "utf-8")
        .split(/\r?\n/)
        .filter((line) => line.trim() && !/^\s*(ADO_EMAIL|ADO_PAT)\s*=/.test(line))
    : [];
  writeFileSync(path, [...kept, `ADO_EMAIL=${email}`, `ADO_PAT=${pat}`].join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  return path;
}

export interface UserSettings {
  /**
   * The user's decision about NPU/GPU acceleration: true = register the accelerator runtimes at every start
   * (registration lasts only for the process that did it), false = declined, undefined = never asked.
   */
  accelerators?: boolean;
  /**
   * Model builds (by id) that failed to load on this machine — e.g. an NPU build the installed NPU driver is too old
   * for. They are skipped on later starts instead of being downloaded and failed again; choosing "Enable NPU / GPU
   * acceleration" clears the list so a fixed driver can be tried.
   */
  blockedBuilds?: string[];
}

/** Per-user settings (~/.traceforge/settings.json). A missing or unreadable file just means "no decisions yet". */
export function loadUserSettings(dir: string = userConfigDir()): UserSettings {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8"));
    const settings: UserSettings = {};
    if (typeof raw?.accelerators === "boolean") settings.accelerators = raw.accelerators;
    if (Array.isArray(raw?.blockedBuilds)) settings.blockedBuilds = raw.blockedBuilds.filter((b: unknown) => typeof b === "string");
    return settings;
  } catch {
    return {};
  }
}

export function saveUserSettings(patch: UserSettings, dir: string = userConfigDir()): void {
  mkdirSync(dir, { recursive: true });
  const merged = { ...loadUserSettings(dir), ...patch };
  writeFileSync(join(dir, "settings.json"), JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

export function hasAdoCredentials(): boolean {
  return Boolean(process.env.ADO_EMAIL && process.env.ADO_PAT);
}

export interface AdoCredentials {
  email: string;
  pat: string;
}

/** Reads ADO_EMAIL / ADO_PAT from the environment (populated via dotenv from a gitignored .env). */
export function loadAdoCredentials(): AdoCredentials {
  const email = process.env.ADO_EMAIL;
  const pat = process.env.ADO_PAT;
  if (!email || !pat) {
    throw new Error(
      "Missing Azure DevOps credentials. Set ADO_EMAIL and ADO_PAT in either a .env file in this repo (kept out of git) " +
        "or, to use them from every repo, in a per-user file at ~/.traceforge/.env (see .env.example for the format)."
    );
  }
  return { email, pat };
}
