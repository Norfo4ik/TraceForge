import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ToolHandler } from "./toolRegistry.js";

const MAX_FILE_BYTES = 20_000;
const MAX_GREP_RESULTS = 60;

let cachedRepoRoot: string | undefined;

export function getRepoRoot(cwd: string = process.cwd()): string {
  if (cachedRepoRoot) return cachedRepoRoot;
  try {
    // stderr piped (not inherited): "not a git repository" is an expected answer here, not something to print.
    cachedRepoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(`"${cwd}" is not inside a git repository.`);
  }
  return cachedRepoRoot;
}

/** Resolves a repo-relative path and guards against escaping the repo root. */
function resolveInRepo(repoRoot: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error("Path must be relative to the repository root.");
  }
  const abs = resolve(repoRoot, relPath);
  const rel = relative(repoRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path "${relPath}" escapes the repository root.`);
  }
  return abs;
}

function git(repoRoot: string, args: string[]): string {
  // stderr is piped (not inherited) so expected failures like "no commits yet" don't leak into the CLI's output.
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const NOISE_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.gitignore|\.gitattributes)$/i;

/** Files whose text matches keywords by coincidence (ignore lists, lockfiles) or that this tool itself generated. */
export function isNoisePath(path: string): boolean {
  return NOISE_FILES.test(path) || path.startsWith(".traceforge/") || path === "docs/GENERATED_OVERVIEW.md";
}

/**
 * Collects the real facts an onboarding doc should be built from — tracked file list, the
 * manifest/README/entry-point contents, and recent commits — so the model summarizes evidence
 * instead of guessing what "a typical repo" contains.
 */
export function gatherRepoOverview(repoRoot: string): { text: string; fileCount: number } {
  const files = git(repoRoot, ["ls-files"]).split("\n").filter((f) => f && !isNoisePath(f));
  // Shallowest match wins, so a solution-style layout (Repo/Project/Program.cs) is found as well as a flat one.
  const pick = (re: RegExp) =>
    files.filter((f) => re.test(f)).sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length)[0];
  const keyPaths = [
    ...new Set(
      [
        pick(/(^|\/)readme(\.md|\.txt)?$/i),
        pick(/(^|\/)package\.json$/),
        pick(/(^|\/)pyproject\.toml$/),
        pick(/(^|\/)requirements\.txt$/),
        pick(/(^|\/)go\.mod$/),
        pick(/(^|\/)pom\.xml$/),
        pick(/(^|\/)cargo\.toml$/i),
        pick(/\.csproj$/),
        pick(/(^|\/)(index|main|cli|app|server|program|startup)\.(ts|tsx|js|jsx|py|cs|go)$/i),
      ].filter((p): p is string => Boolean(p))
    ),
  ].slice(0, 5);

  const sections: string[] = [
    `Tracked files (${files.length}${files.length > 100 ? ", first 100 shown" : ""}):\n${files.slice(0, 100).join("\n")}`,
  ];
  for (const rel of keyPaths) {
    try {
      const content = readFileSync(resolveInRepo(repoRoot, rel), "utf-8");
      const max = /^readme/i.test(rel) ? 2500 : 2000;
      sections.push(`--- ${rel} ---\n${content.length > max ? `${content.slice(0, max)}\n… [truncated]` : content}`);
    } catch {
      // unreadable file — skip
    }
  }
  try {
    const log = git(repoRoot, ["log", "--max-count=10", "--pretty=format:%h %ad %an: %s", "--date=short"]).trim();
    sections.push(`--- Recent commits ---\n${log || "(no commits yet)"}`);
  } catch {
    sections.push("--- Recent commits ---\n(no commits yet)");
  }
  return { text: sections.join("\n\n"), fileCount: files.length };
}

export interface RepoSearchHit {
  term: string;
  matches: string[];
}

/** Greps the repo for each term (fixed-string, case-insensitive) and returns a few `file:line:text` hits per term. */
export function searchRepoForTerms(
  repoRoot: string,
  terms: string[],
  perTerm = 4
): RepoSearchHit[] {
  const hits: RepoSearchHit[] = [];
  for (const term of terms) {
    try {
      const out = git(repoRoot, ["grep", "-n", "-I", "-i", "-F", "--", term]);
      const matches = out
        .split("\n")
        .filter(Boolean)
        .filter((line) => !isNoisePath(line.split(":")[0]))
        .map((line) => (line.length > 200 ? `${line.slice(0, 200)}…` : line))
        .slice(0, perTerm);
      if (matches.length) hits.push({ term, matches });
    } catch {
      // git grep exits 1 when there are no matches — nothing to record.
    }
  }
  return hits;
}

export function createRepoTools(repoRoot: string = getRepoRoot()): ToolHandler[] {
  return [
    {
      name: "list_files",
      description:
        "List git-tracked files in the repository, optionally filtered by a glob-like pathspec (e.g. 'src/**/*.ts'). Ignores files excluded by .gitignore.",
      parameters: {
        type: "object",
        properties: {
          pathspec: { type: "string", description: "Optional git pathspec to filter results, e.g. 'src/*.ts'." },
        },
      },
      execute: async (args) => {
        const pathspec = typeof args.pathspec === "string" ? args.pathspec : undefined;
        const gitArgs = ["ls-files"];
        if (pathspec) gitArgs.push("--", pathspec);
        const files = git(repoRoot, gitArgs).split("\n").filter(Boolean);
        return JSON.stringify({ count: files.length, files: files.slice(0, 300) });
      },
    },
    {
      name: "read_file",
      description: `Read a text file from the repository by its path relative to the repo root. Truncated to ${MAX_FILE_BYTES} bytes.`,
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the repository root." },
        },
        required: ["path"],
      },
      execute: async (args) => {
        const relPath = String(args.path ?? "");
        const abs = resolveInRepo(repoRoot, relPath);
        const stat = statSync(abs);
        if (!stat.isFile()) {
          return JSON.stringify({ error: `"${relPath}" is not a file.` });
        }
        const content = readFileSync(abs, "utf-8");
        const truncated = content.length > MAX_FILE_BYTES;
        return JSON.stringify({
          path: relPath,
          truncated,
          content: truncated ? content.slice(0, MAX_FILE_BYTES) : content,
        });
      },
    },
    {
      name: "grep_repo",
      description: "Search git-tracked file contents for a regular expression. Returns matching file:line:text entries.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Extended regular expression to search for." },
          pathspec: { type: "string", description: "Optional git pathspec to limit the search, e.g. 'src/'." },
        },
        required: ["pattern"],
      },
      execute: async (args) => {
        const pattern = String(args.pattern ?? "");
        const pathspec = typeof args.pathspec === "string" ? args.pathspec : undefined;
        const gitArgs = ["grep", "-n", "-I", "-E", pattern];
        if (pathspec) gitArgs.push("--", pathspec);
        try {
          const output = git(repoRoot, gitArgs);
          const lines = output.split("\n").filter(Boolean);
          return JSON.stringify({ count: lines.length, matches: lines.slice(0, MAX_GREP_RESULTS) });
        } catch (err) {
          // git grep exits 1 with empty output when there are no matches — not a real error.
          const e = err as { status?: number; stdout?: string };
          if (e.status === 1) {
            return JSON.stringify({ count: 0, matches: [] });
          }
          throw err;
        }
      },
    },
    {
      name: "git_log",
      description: "Show recent commit history, optionally scoped to a path.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Optional file or directory path to scope the log to." },
          maxCount: { type: "number", description: "Maximum number of commits to return (default 20)." },
        },
      },
      execute: async (args) => {
        const path = typeof args.path === "string" ? args.path : undefined;
        const maxCount = typeof args.maxCount === "number" && args.maxCount > 0 ? Math.floor(args.maxCount) : 20;
        const gitArgs = ["log", `--max-count=${maxCount}`, "--pretty=format:%h %ad %an: %s", "--date=short"];
        if (path) gitArgs.push("--", path);
        const output = git(repoRoot, gitArgs);
        return JSON.stringify({ commits: output.split("\n").filter(Boolean) });
      },
    },
    {
      name: "git_diff",
      description: "Show the diff between two git refs (default: working tree vs HEAD), optionally scoped to a path.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "Base ref, e.g. 'HEAD~1'. Defaults to HEAD." },
          to: { type: "string", description: "Target ref. Defaults to the working tree." },
          path: { type: "string", description: "Optional file or directory path to scope the diff to." },
        },
      },
      execute: async (args) => {
        const from = typeof args.from === "string" ? args.from : "HEAD";
        const to = typeof args.to === "string" ? args.to : undefined;
        const path = typeof args.path === "string" ? args.path : undefined;
        const gitArgs = ["diff", to ? `${from}..${to}` : from];
        if (path) gitArgs.push("--", path);
        const output = git(repoRoot, gitArgs);
        const MAX_DIFF_CHARS = 20_000;
        const truncated = output.length > MAX_DIFF_CHARS;
        return JSON.stringify({ truncated, diff: truncated ? output.slice(0, MAX_DIFF_CHARS) : output });
      },
    },
  ];
}
