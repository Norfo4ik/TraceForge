import { execSync } from "node:child_process";
import { defineConfig } from "tsup";

/** Short git commit of the source being built, so a running copy can say exactly which build it is. */
function buildCommit(): string {
  try {
    const sha = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() !== "";
    return dirty ? `${sha}+local changes` : sha;
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  define: { __BUILD_COMMIT__: JSON.stringify(buildCommit()) },
});
