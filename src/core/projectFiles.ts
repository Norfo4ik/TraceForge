import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse } from "node:path";

/** A project is either a git repository or a plain folder (no history, files only). */
export type ProjectKind = "git" | "folder";

// Folders that hold dependencies, build output or tool state — never the code a person wants to ask about.
const SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", "out", "bin", "obj", "target", "vendor", ".vs", ".idea", "venv", ".venv",
  "__pycache__", ".next", ".nuxt", "coverage", ".gradle", ".cache", ".pytest_cache", ".traceforge", ".localdevops",
]);

const BINARY_OR_NOISE = /\.(png|jpe?g|gif|ico|bmp|webp|svg|pdf|zip|gz|tgz|7z|rar|exe|dll|pdb|so|dylib|class|jar|war|woff2?|ttf|eot|mp[34]|mov|avi|wasm|bin|dat|db|sqlite|pfx|snk|lock)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|cs|java|go|rs|rb|php|cpp|cc|c|h|hpp|kt|swift|scala|sql|html|css|scss|vue|svelte|md|json|ya?ml|toml|sln|csproj)$/i;

export interface WalkResult {
  /** Paths relative to the root, with forward slashes, in a stable order. */
  files: string[];
  /** True when the walk stopped at the limit, so the list is only part of the folder. */
  truncated: boolean;
}

/** Lists the readable project files under `root`, skipping dependency/build folders, binaries and symlinks. */
export function walkProject(root: string, options: { maxFiles?: number; maxDepth?: number } = {}): WalkResult {
  const maxFiles = options.maxFiles ?? 3000;
  const maxDepth = options.maxDepth ?? 10;
  const files: string[] = [];
  let truncated = false;

  const visit = (dir: string, relDir: string, depth: number): void => {
    if (truncated) return;
    let entries;
    try {
      // Plain code-point order (not localeCompare, which varies by machine locale) so the file list is stable everywhere.
      entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return; // unreadable folder — skip it
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.isSymbolicLink()) continue; // avoids loops and escaping the project
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && depth < maxDepth) visit(join(dir, entry.name), rel, depth + 1);
      } else if (entry.isFile() && !BINARY_OR_NOISE.test(rel)) {
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
        files.push(rel);
      }
    }
  };

  visit(root, "", 0);
  return { files, truncated };
}

/**
 * Does this folder look like a software project worth asking about? Not a drive root or the home folder (walking those
 * would be enormous and meaningless), and it must contain at least one source, config or doc file near the top.
 */
export function looksLikeProject(root: string): boolean {
  if (root === parse(root).root || root === homedir()) return false;
  const { files } = walkProject(root, { maxFiles: 300, maxDepth: 3 });
  return files.some((f) => SOURCE_FILE.test(f));
}

export interface GrepOptions {
  maxResults?: number;
  maxFileBytes?: number;
}

/** Searches the given files for a regular expression (falling back to plain text if it isn't a valid one). */
export function grepFiles(root: string, files: string[], pattern: string, options: GrepOptions = {}): string[] {
  const maxResults = options.maxResults ?? 60;
  const maxFileBytes = options.maxFileBytes ?? 500_000;
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern);
  } catch {
    matcher = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }

  const hits: string[] = [];
  for (const file of files) {
    if (hits.length >= maxResults) break;
    let text: string;
    try {
      const abs = join(root, file);
      if (statSync(abs).size > maxFileBytes) continue;
      text = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue; // binary
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
      if (matcher.test(lines[i])) hits.push(`${file}:${i + 1}:${lines[i].length > 200 ? `${lines[i].slice(0, 200)}…` : lines[i]}`);
    }
  }
  return hits;
}
