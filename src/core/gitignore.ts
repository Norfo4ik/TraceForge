import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Appends any missing entries to the repo's root .gitignore (creating it if needed) and returns the ones added.
 * Never rewrites or reorders existing lines.
 */
export function ensureGitignored(repoRoot: string, entries: string[]): string[] {
  const path = join(repoRoot, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim().replace(/^\//, "").replace(/\/$/, "")));
  const missing = entries.filter((e) => !present.has(e.replace(/\/$/, "")));
  if (missing.length === 0) return [];

  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : eol;
  writeFileSync(path, `${existing}${prefix}${eol}# TraceForge${eol}${missing.join(eol)}${eol}`, "utf-8");
  return missing;
}
