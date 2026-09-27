import { spawnSync } from "node:child_process";
import { logger } from "../utils/logger.js";
import { VERSION_LABEL } from "../version.js";

/** The tarball the release workflow attaches to every GitHub release; the same one install.ps1 installs. */
export const RELEASE_URL = "https://github.com/Norfo4ik/TraceForge/releases/latest/download/traceforge.tgz";

export interface UpdateOptions {
  /** Install from this tarball or URL instead of the latest release (e.g. a specific release, or a local build). */
  source?: string;
}

/** Reinstalls TraceForge globally from the latest release, exactly as the install script does. */
export async function runUpdate(opts: UpdateOptions = {}): Promise<void> {
  const source = opts.source ?? RELEASE_URL;
  logger.info(`Installed: ${VERSION_LABEL}`);
  logger.info(`Installing from ${source}`);
  if (/["`$%&|<>^\r\n]/.test(source)) throw new Error("That source contains characters that can't be passed to npm safely.");
  // One command string with shell: true, because npm is npm.cmd on Windows, which can't be spawned directly.
  const result = spawnSync(`npm install --global "${source}"`, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    throw new Error(
      "The update failed (see npm's message above). If it says the file was not found, no release has been published yet; " +
        "if it mentions permissions, run the terminal as the same user that installed TraceForge."
    );
  }
  logger.ok('Updated. Run "traceforge --version" to see the new version.');
}
