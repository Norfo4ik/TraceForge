// Kept in sync with package.json by a unit test (src/version.test.ts).
export const VERSION = "0.1.0";

// Injected at build time by tsup.config.ts. Absent when running from source (tsx, tests).
declare const __BUILD_COMMIT__: string | undefined;

/** The git commit this build was made from, or "dev" when run from source. */
export const BUILD_COMMIT: string = typeof __BUILD_COMMIT__ === "undefined" ? "dev" : __BUILD_COMMIT__;

/** e.g. "0.1.0 (14e970a)" — shown in the header and by --version so it's clear which build is running. */
export const VERSION_LABEL = `${VERSION} (${BUILD_COMMIT})`;
