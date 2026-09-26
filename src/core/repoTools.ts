import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { truncateText } from "./contextBudget.js";
import { grepFiles, looksLikeProject, walkProject, type ProjectKind } from "./projectFiles.js";
import type { ToolHandler } from "./toolRegistry.js";

const MAX_FILE_BYTES = 20_000;
const MAX_GREP_RESULTS = 60;

// Keyed by folder: a single cached value ignored the `cwd` argument, so asking about a second folder returned the first
// folder's repository. Only successes are cached — a folder can become a repository (git init) while the app runs.
const repoRootByCwd = new Map<string, string>();

export function getRepoRoot(cwd: string = process.cwd()): string {
  const cached = repoRootByCwd.get(cwd);
  if (cached) return cached;
  try {
    // stderr piped (not inherited): "not a git repository" is an expected answer here, not something to print.
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    repoRootByCwd.set(cwd, root);
    return root;
  } catch {
    throw new Error(`"${cwd}" is not inside a git repository.`);
  }
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

export interface OverviewOptions {
  /** Largest overview to return, in characters. The overview shrinks in steps until it fits (see OVERVIEW_LEVELS). */
  maxChars?: number;
}

// From the full picture down to the bare minimum. A big repository's full overview can be ~12k characters, which
// alone overflows a 4k-token model window, so the overview is built at the largest level that fits the budget.
const OVERVIEW_LEVELS = [
  { files: 100, keyFiles: 5, readmeChars: 2500, otherChars: 2000, commits: 10 },
  { files: 50, keyFiles: 4, readmeChars: 1200, otherChars: 900, commits: 8 },
  { files: 25, keyFiles: 3, readmeChars: 600, otherChars: 450, commits: 5 },
  { files: 12, keyFiles: 2, readmeChars: 350, otherChars: 250, commits: 3 },
  { files: 6, keyFiles: 1, readmeChars: 250, otherChars: 200, commits: 2 },
];

/**
 * Collects the real facts an onboarding doc should be built from — tracked file list, the
 * manifest/README/entry-point contents, and recent commits — so the model summarizes evidence
 * instead of guessing what "a typical repo" contains. With `maxChars`, the overview is made smaller
 * (fewer files, shorter excerpts, fewer commits) until it fits the model's context window.
 */
export function gatherRepoOverview(
  repoRoot: string,
  kind: ProjectKind = "git",
  options: OverviewOptions = {}
): { text: string; fileCount: number } {
  const walked = kind === "git" ? undefined : walkProject(repoRoot);
  const files = (walked ? walked.files : git(repoRoot, ["ls-files"]).split("\n")).filter((f) => f && !isNoisePath(f));
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

  // Read everything once; each level below only slices what it needs.
  const keyFiles: Array<{ rel: string; content: string }> = [];
  for (const rel of keyPaths) {
    try {
      keyFiles.push({ rel, content: readFileSync(resolveInRepo(repoRoot, rel), "utf-8") });
    } catch {
      // unreadable file — skip
    }
  }
  let commitLines: string[] | undefined;
  if (kind === "git") {
    try {
      commitLines = git(repoRoot, ["log", "--max-count=10", "--pretty=format:%h %ad %an: %s", "--date=short"])
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      commitLines = [];
    }
  }

  const label = kind === "git" ? "Tracked files" : "Project files";
  const partial = walked?.truncated ? ", folder is larger than the scan limit" : "";
  const render = (level: (typeof OVERVIEW_LEVELS)[number]): string => {
    const listed = files.slice(0, level.files);
    const sections: string[] = [
      `${label} (${files.length}${files.length > listed.length ? `, first ${listed.length} shown` : ""}${partial}):\n${listed.join("\n")}`,
    ];
    for (const { rel, content } of keyFiles.slice(0, level.keyFiles)) {
      const max = /^readme/i.test(rel) ? level.readmeChars : level.otherChars;
      sections.push(`--- ${rel} ---\n${content.length > max ? `${content.slice(0, max)}\n… [truncated]` : content}`);
    }
    if (kind === "folder") {
      sections.push("--- Recent commits ---\n(this is a plain folder, not a git repository — there is no commit history)");
    } else {
      const shown = (commitLines ?? []).slice(0, level.commits);
      sections.push(`--- Recent commits ---\n${shown.length ? shown.join("\n") : "(no commits yet)"}`);
    }
    return sections.join("\n\n");
  };

  const limit = options.maxChars ?? Number.POSITIVE_INFINITY;
  let text = "";
  for (const level of OVERVIEW_LEVELS) {
    text = render(level);
    if (text.length <= limit) break;
  }
  return { text: truncateText(text, limit), fileCount: files.length };
}

/**
 * Where TraceForge is looking: the enclosing git repository if there is one, otherwise the current folder when it
 * looks like a software project (files only — no history). Undefined when there's nothing sensible to look at.
 */
export function resolveProject(cwd: string = process.cwd()): { root: string; kind: ProjectKind } | undefined {
  try {
    return { root: getRepoRoot(cwd), kind: "git" };
  } catch {
    return looksLikeProject(cwd) ? { root: cwd, kind: "folder" } : undefined;
  }
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

export function createRepoTools(repoRoot: string = getRepoRoot(), kind: ProjectKind = "git"): ToolHandler[] {
  const tools: ToolHandler[] = [
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
  if (kind === "git") return tools;

  // A plain folder has no git, so listing and searching work on the files themselves and the history tools are left
  // out entirely (a model offered them would call them and get errors, or invent an answer).
  return tools
    .filter((t) => t.name !== "git_log" && t.name !== "git_diff")
    .map((t): ToolHandler => {
      if (t.name === "list_files") {
        return {
          ...t,
          description: "List the project's files, optionally only those whose path contains the given text (e.g. 'src/' or '.ts'). Skips dependency and build folders.",
          parameters: { type: "object", properties: { pathspec: { type: "string", description: "Optional text the path must contain, e.g. 'src/' or '.cs'." } } },
          execute: async (args) => {
            const filter = typeof args.pathspec === "string" ? args.pathspec.replace(/^\.?\//, "") : "";
            const files = walkProject(repoRoot).files.filter((f) => !filter || f.includes(filter));
            return JSON.stringify({ count: files.length, files: files.slice(0, 300) });
          },
        };
      }
      if (t.name === "grep_repo") {
        return {
          ...t,
          description: "Search the project's text files for a regular expression. Returns matching file:line:text entries.",
          parameters: {
            type: "object",
            properties: {
              pattern: { type: "string", description: "Regular expression to search for." },
              pathspec: { type: "string", description: "Optional text the path must contain, e.g. 'src/'." },
            },
            required: ["pattern"],
          },
          execute: async (args) => {
            const filter = typeof args.pathspec === "string" ? args.pathspec.replace(/^\.?\//, "") : "";
            const files = walkProject(repoRoot).files.filter((f) => !filter || f.includes(filter));
            const matches = grepFiles(repoRoot, files, String(args.pattern ?? ""));
            return JSON.stringify({ count: matches.length, matches });
          },
        };
      }
      return t; // read_file works on any file path inside the project
    });
}
