import { FoundryLocalManager, type IModel, type ModelInfo } from "foundry-local-sdk";
import ora from "ora";
import {
  acceleratedVariants,
  explainLoadFailure,
  loadWithFallback,
  parseDevicePreference,
  pickDefaultModel,
  providersWithoutBuilds,
  rankVariants,
  summarizeBuilds,
  unregisteredProviders,
  type ModelVariant,
} from "./accelerators.js";
import { getContextLimit, loadUserSettings, saveUserSettings, setContextLimit } from "./config.js";
import { debugEnabled } from "../utils/debug.js";
import { logger } from "../utils/logger.js";

// Namespaces Foundry Local's data on disk. Deliberately NOT renamed with the product: changing it may move the
// model cache and force a multi-GB re-download for no user-visible benefit.
const APP_NAME = "local-devops-copilot";

// Tool-calling-capable and reasonably small (~2.8GB). Used unless the user picks a model, or the machine has an
// NPU/GPU that this model has no build for (see pickDefaultModel).
const DEFAULT_ALIAS = "qwen3-4b";

/** The alias the user asked for (argument, then TRACEFORGE_MODEL — read lazily so a .env is honoured), if any. */
function explicitAlias(alias?: string): string | undefined {
  return alias ?? process.env.TRACEFORGE_MODEL ?? undefined;
}

/** Best guess at the model name without touching the catalog (for labels). See planModel for the real choice. */
export function resolveModelAlias(alias?: string): string {
  return explicitAlias(alias) ?? DEFAULT_ALIAS;
}

let manager: FoundryLocalManager | undefined;

/** Builds that failed to load on this machine before (see UserSettings.blockedBuilds). */
export function blockedBuildIds(): string[] {
  return loadUserSettings().blockedBuilds ?? [];
}

function blockBuild(id: string): void {
  const blocked = blockedBuildIds();
  if (!blocked.includes(id)) saveUserSettings({ blockedBuilds: [...blocked, id] });
}

/** Forget failed builds — for retrying after a driver update. */
export function clearBlockedBuilds(): void {
  if (blockedBuildIds().length > 0) saveUserSettings({ blockedBuilds: [] });
}

export function getManager(): FoundryLocalManager {
  if (!manager) {
    manager = FoundryLocalManager.create({
      appName: APP_NAME,
      disableNonessentialTelemetry: true,
      // The native runtime prints its own multi-line errors straight to the terminal (a failed NPU load is ~15 lines
      // of stack-like text). We report failures ourselves in plain English; TRACEFORGE_DEBUG=1 brings its output back.
      logLevel: debugEnabled() ? "info" : "fatal",
    });
  }
  return manager;
}

export interface LoadedModel {
  model: IModel;
  info: ModelInfo;
  /** The model actually loaded — differs from the usual default when an accelerator-capable model was chosen. */
  alias: string;
  switchedFrom?: string;
}

export function describeDevice(info: ModelInfo): string {
  const device = info.runtime?.deviceType ?? info.deviceType;
  const provider = info.runtime?.executionProvider ?? info.executionProvider;
  return provider ? `${device} (${provider})` : String(device);
}

function registeredEps(): Set<string> {
  return new Set(
    getManager()
      .discoverEps()
      .filter((ep) => ep.isRegistered)
      .map((ep) => ep.name)
  );
}

let variantCache: ModelVariant[] | undefined;

async function scanCatalog(): Promise<ModelVariant[]> {
  const found = new Map<string, ModelVariant>();
  const add = (m: IModel) => {
    if (found.has(m.id)) return;
    const info = m.info;
    found.set(m.id, {
      alias: info.alias,
      id: m.id,
      deviceType: String(info.deviceType),
      executionProvider: info.executionProvider ?? info.runtime?.executionProvider,
      fileSizeMb: info.fileSizeMb,
      supportsToolCalling: info.supportsToolCalling,
    });
  };
  for (const model of await getManager().catalog.getModels()) {
    add(model);
    for (const variant of model.variants) add(variant);
  }
  return [...found.values()];
}

let catalogRepaired = false;

/**
 * Every build (CPU / GPU / NPU) of every model in the catalog, flattened. Cached; cleared when providers change.
 * If a runtime is registered but no model uses it, the catalog didn't pick the registration up (seen on real
 * hardware: 1 model listed instead of 35), so register once more and rescan — once — before trusting the result.
 */
async function catalogVariants(): Promise<ModelVariant[]> {
  if (variantCache) return variantCache;
  let variants = await scanCatalog();

  if (!catalogRepaired && providersWithoutBuilds(registeredEps(), variants).length > 0) {
    catalogRepaired = true;
    try {
      await getManager().downloadAndRegisterEps(() => {});
      variants = await scanCatalog();
    } catch {
      // keep what we have; doctor shows the per-runtime build counts so the situation is visible
    }
  }
  variantCache = variants;
  return variantCache;
}

/** How many NPU/GPU builds the catalog offers per registered runtime, and any registered runtime with none. */
export async function catalogReport(): Promise<{ builds: string[]; unused: string[] }> {
  const variants = await catalogVariants();
  return { builds: summarizeBuilds(variants), unused: providersWithoutBuilds(registeredEps(), variants) };
}

/** Models that have an NPU/GPU build this machine can run right now (their runtime is registered). */
export async function acceleratedModels(): Promise<ModelVariant[]> {
  return acceleratedVariants(await catalogVariants(), registeredEps());
}

/**
 * Downloads and registers every execution provider this machine can use (NPU / GPU runtimes). Opt-in via
 * `doctor --accelerate` because the packages are large. NOTE: the download is cached on disk, but registration
 * only lasts for the current process — so {@link prepareAccelerators} repeats it at every start once the user
 * has opted in.
 */
export async function registerAccelerators(
  onProgress: (provider: string, percent: number) => void
): Promise<{ success: boolean; registered: string[]; failed: string[] }> {
  const result = await getManager().downloadAndRegisterEps(onProgress);
  variantCache = undefined;
  catalogRepaired = false;
  prepared = Promise.resolve();
  return { success: result.success, registered: [...result.registeredEps], failed: [...result.failedEps] };
}

let prepared: Promise<void> | undefined;

/** Registration can finish a moment after the call returns; wait (briefly) until the runtimes report registered. */
async function waitUntilRegistered(names: string[], timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillPending = unregisteredProviders(getManager().discoverEps()).filter((n) => names.includes(n));
    if (stillPending.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Registers the NPU/GPU runtimes for this process if the user has opted in. Registration doesn't survive a restart
 * (found on real hardware: `doctor --accelerate` reported success and the next command started unregistered), so
 * without this every launch would silently run on the CPU. Quick when the packages are already downloaded; if it
 * fails (offline, driver) the app carries on with whatever is registered. Safe to call repeatedly.
 */
export function prepareAccelerators(): Promise<void> {
  prepared ??= (async () => {
    if (process.env.TRACEFORGE_ACCELERATE?.trim().toLowerCase() === "off") return;
    if (loadUserSettings().accelerators !== true) return;
    const pending = unregisteredProviders(getManager().discoverEps());
    if (pending.length === 0) return;
    try {
      // The register-everything form, like `doctor --accelerate` uses: registering a named list left the model
      // catalog with 1 model on real hardware where this form produced the full 35.
      const result = await getManager().downloadAndRegisterEps(() => {});
      await waitUntilRegistered(pending);
      variantCache = undefined;
      if (result.failedEps.length) logger.warn(`Could not enable ${result.failedEps.join(", ")} — continuing without it.`);
    } catch (err) {
      logger.warn(`Could not enable NPU/GPU acceleration (${err instanceof Error ? err.message : String(err)}) — continuing on the CPU.`);
    }
  })();
  return prepared;
}

interface ModelTarget {
  alias: string;
  switchedFrom?: string;
}

/**
 * Decides which model to use. An explicit choice (argument, repo config or TRACEFORGE_MODEL) is always respected.
 * Otherwise the usual default is used — unless the machine has a registered NPU/GPU that the default has no build
 * for, in which case the best model that does is chosen so the hardware doesn't sit idle.
 */
async function resolveTarget(alias?: string): Promise<ModelTarget> {
  await prepareAccelerators();
  const explicit = explicitAlias(alias);
  if (explicit) return { alias: explicit };
  const force = parseDevicePreference(process.env.TRACEFORGE_DEVICE);
  const blocked = new Set(blockedBuildIds());
  const usable = (await catalogVariants()).filter((v) => !blocked.has(v.id));
  const choice = pickDefaultModel(usable, registeredEps(), DEFAULT_ALIAS, force);
  return { alias: choice.alias, switchedFrom: choice.switchedFrom };
}

/**
 * The model's builds that can run here, best first (NPU > GPU > CPU, or only the device forced via TRACEFORGE_DEVICE),
 * minus any that failed to load before. This order is also the fallback order when a load fails.
 */
function rankedBuilds(model: IModel): IModel[] {
  const force = parseDevicePreference(process.env.TRACEFORGE_DEVICE);
  const ranked = rankVariants(
    model.variants.map((v) => ({ id: v.id, deviceType: String(v.info.deviceType), executionProvider: v.info.executionProvider })),
    registeredEps(),
    force,
    new Set(blockedBuildIds())
  );
  return ranked.flatMap((r) => model.variants.filter((v) => v.id === r.id));
}

/** Selects the best runnable build on the model. */
function selectBestVariant(model: IModel, alias: string): void {
  const force = parseDevicePreference(process.env.TRACEFORGE_DEVICE);
  if (process.env.TRACEFORGE_DEVICE && !force) {
    logger.warn(`Ignoring TRACEFORGE_DEVICE="${process.env.TRACEFORGE_DEVICE}" (expected npu, gpu or cpu).`);
  }

  const [best] = rankedBuilds(model);
  if (!best) {
    if (force) {
      logger.warn(`No ${force} build of "${alias}" is available on this machine — using the default. (Run "traceforge doctor --accelerate" to register NPU/GPU providers.)`);
    }
    return;
  }
  if (best.id !== model.id) model.selectVariant(best);
}

/** What `ensureModel` would use, without downloading or loading anything — for the status panel and `doctor`. */
export async function planModel(alias?: string): Promise<{
  alias: string;
  cached: boolean;
  sizeMb?: number;
  device: string;
  switchedFrom?: string;
}> {
  const target = await resolveTarget(alias);
  const model = await getManager().catalog.getModel(target.alias);
  selectBestVariant(model, target.alias);
  return {
    alias: target.alias,
    cached: model.isCached,
    sizeMb: model.info.fileSizeMb,
    device: describeDevice(model.info),
    switchedFrom: target.switchedFrom,
  };
}

/** Marks a failure as happening while loading (as opposed to downloading), which decides how we recover. */
class ModelLoadError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
  }
}

async function downloadAndLoad(model: IModel, name: string): Promise<void> {
  if (!model.isCached) {
    const spinner = ora(`Downloading model "${name}" (first run only, this can take a while)...`).start();
    try {
      await model.download((pct) => {
        spinner.text = `Downloading model "${name}"... ${Math.round(pct)}%`;
      });
      spinner.succeed(`Model "${name}" downloaded`);
    } catch (err) {
      spinner.fail(`Could not download model "${name}"`);
      throw err;
    }
  }

  if (!(await model.isLoaded())) {
    const spinner = ora(`Loading model "${name}" into memory...`).start();
    try {
      await model.load();
      spinner.succeed(`Model "${name}" loaded`);
    } catch (err) {
      // No red failure line: the caller explains it in plain English and may recover by trying another build.
      spinner.stop();
      throw new ModelLoadError(err);
    }
  }
}

/** Ensures the model is downloaded and loaded on the best available device, ready for a ChatSession. */
export async function ensureModel(alias?: string): Promise<LoadedModel> {
  const target = await resolveTarget(alias);
  const name = target.alias;
  const model = await getManager().catalog.getModel(name);
  selectBestVariant(model, name);

  if (target.switchedFrom) {
    logger.info(
      `${target.switchedFrom} has no ${String(model.info.runtime?.deviceType ?? model.info.deviceType)} build on this machine, so using ${name} to run on it. ` +
        `(Set TRACEFORGE_MODEL to choose a model yourself, or TRACEFORGE_DEVICE=cpu to stay on the CPU.)`
    );
  }

  // Try the builds best-first. A build can fail to load (an NPU driver older than the model needs, not enough memory…):
  // say why in plain English, remember it so later starts skip it, and move down to the next device rather than stranding
  // the user. Whatever gets loaded, `info` below reports the build that actually is.
  const attempts = rankedBuilds(model);
  if (attempts.length === 0) attempts.push(model);

  const deviceOf = (b: IModel) => String(b.info.runtime?.deviceType ?? b.info.deviceType);
  const tryingNext = (next: IModel | undefined) => {
    if (next) logger.info(`  Trying the ${deviceOf(next)} build instead${next.isCached ? "" : " (needs a download)"}.`);
  };

  const outcome = await loadWithFallback(
    attempts,
    async (build) => {
      if (build.id !== model.id) model.selectVariant(build);
      await downloadAndLoad(model, name);
    },
    {
      describe: (b) => ({ id: b.id, device: deviceOf(b), cached: b.isCached }),
      isLoadError: (err) => err instanceof ModelLoadError,
      onLoadFailure: (build, err, next) => {
        const message = (err as Error).message;
        const why = explainLoadFailure(message);
        logger.warn(`Couldn't run ${name} on the ${deviceOf(build)}: ${why.summary}.`);
        if (why.hint) logger.info(`  ${why.hint}`);
        if (debugEnabled()) logger.info(`  Details: ${message}`);
        if (deviceOf(build) !== "CPU") blockBuild(build.id); // don't download and fail the same build on every start
        tryingNext(next);
      },
      onDownloadFailure: (build, _err, next) => {
        logger.warn(`Couldn't download the ${deviceOf(build)} build of ${name}; using a build that is already on this machine.`);
        tryingNext(next);
      },
    }
  );

  if ("error" in outcome) {
    const err = outcome.error;
    const why = err instanceof ModelLoadError ? explainLoadFailure(err.message).summary : err instanceof Error ? err.message : String(err);
    throw new Error(`${name} could not be loaded on any available device: ${why}`);
  }

  const info = model.info;
  logger.ok(`Model "${name}" ready on ${describeDevice(info)}`);
  return { model, info, alias: name, switchedFrom: target.switchedFrom };
}

/**
 * The model's context window in tokens: the catalog's figure if it has one, otherwise a limit learned from an earlier
 * overflow. Often unknown — the catalog doesn't report it for every model — in which case prompts start unbudgeted
 * and the first overflow teaches us the real number (see runWithContextRetry).
 */
export function contextWindow(model: IModel, info: ModelInfo, alias: string): number | undefined {
  return model.contextLength ?? info.contextLength ?? getContextLimit(alias) ?? undefined;
}

export function rememberContextWindow(alias: string, limit: number): void {
  setContextLimit(alias, limit);
  logger.info(`  ${alias} has a ${limit}-token context window; retrying with a prompt sized to it (remembered for next time).`);
}

/** One-line proof point for the demo: where inference ran and how long it took. */
export function logOnDeviceSummary(info: ModelInfo, startedAt: number): void {
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(`Inference ran on-device on ${describeDevice(info)} in ${seconds}s — no prompt or code was sent to a cloud AI service.`);
}

let keepAlive = false;

/**
 * The interactive menu runs many actions in one process. The native manager is a per-process singleton
 * (creating a second one is documented to throw), and a loaded model makes later actions start faster,
 * so while the menu is open the per-command shutdowns become no-ops; the menu shuts down for real on exit.
 */
export function keepFoundryLocalAlive(on: boolean): void {
  keepAlive = on;
}

/** Releases the native manager. Call once, after all sessions built on it are disposed. */
export function shutdownFoundryLocal(): void {
  if (keepAlive) return;
  manager?.dispose();
  manager = undefined;
}
