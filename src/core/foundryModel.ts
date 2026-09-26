import { FoundryLocalManager, type IModel, type ModelInfo } from "foundry-local-sdk";
import ora from "ora";
import {
  acceleratedVariants,
  chooseVariant,
  parseDevicePreference,
  pickDefaultModel,
  type ModelVariant,
} from "./accelerators.js";
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

export function getManager(): FoundryLocalManager {
  if (!manager) {
    manager = FoundryLocalManager.create({
      appName: APP_NAME,
      disableNonessentialTelemetry: true,
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

/** Every build (CPU / GPU / NPU) of every model in the catalog, flattened. Cached; cleared when providers change. */
async function catalogVariants(): Promise<ModelVariant[]> {
  if (variantCache) return variantCache;
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
  variantCache = [...found.values()];
  return variantCache;
}

/** Models that have an NPU/GPU build this machine can run right now (their runtime is registered). */
export async function acceleratedModels(): Promise<ModelVariant[]> {
  return acceleratedVariants(await catalogVariants(), registeredEps());
}

/**
 * Downloads and registers every execution provider this machine can use (NPU / GPU runtimes). Opt-in via
 * `doctor --accelerate` because the packages are large; once registered they persist, and model selection
 * then uses them automatically.
 */
export async function registerAccelerators(
  onProgress: (provider: string, percent: number) => void
): Promise<{ success: boolean; registered: string[]; failed: string[] }> {
  const result = await getManager().downloadAndRegisterEps(onProgress);
  variantCache = undefined;
  return { success: result.success, registered: [...result.registeredEps], failed: [...result.failedEps] };
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
  const explicit = explicitAlias(alias);
  if (explicit) return { alias: explicit };
  const force = parseDevicePreference(process.env.TRACEFORGE_DEVICE);
  const choice = pickDefaultModel(await catalogVariants(), registeredEps(), DEFAULT_ALIAS, force);
  return { alias: choice.alias, switchedFrom: choice.switchedFrom };
}

/** Selects the best runnable build (NPU > GPU > CPU, or the one forced via TRACEFORGE_DEVICE) on the model. */
function selectBestVariant(model: IModel, alias: string): void {
  const force = parseDevicePreference(process.env.TRACEFORGE_DEVICE);
  if (process.env.TRACEFORGE_DEVICE && !force) {
    logger.warn(`Ignoring TRACEFORGE_DEVICE="${process.env.TRACEFORGE_DEVICE}" (expected npu, gpu or cpu).`);
  }

  const variants = model.variants;
  const best = chooseVariant(
    variants.map((v) => ({ id: v.id, deviceType: String(v.info.deviceType), executionProvider: v.info.executionProvider })),
    registeredEps(),
    force
  );

  if (!best) {
    if (force) {
      logger.warn(`No ${force} build of "${alias}" is available on this machine — using the default. (Run "traceforge doctor --accelerate" to register NPU/GPU providers.)`);
    }
    return;
  }
  const chosen = variants.find((v) => v.id === best.id);
  if (chosen && chosen.id !== model.id) model.selectVariant(chosen);
}

/** What `ensureModel` would use, without downloading or loading anything — for the status panel and `doctor`. */
export async function planModel(
  alias?: string
): Promise<{ alias: string; cached: boolean; device: string; switchedFrom?: string }> {
  const target = await resolveTarget(alias);
  const model = await getManager().catalog.getModel(target.alias);
  selectBestVariant(model, target.alias);
  return { alias: target.alias, cached: model.isCached, device: describeDevice(model.info), switchedFrom: target.switchedFrom };
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
      spinner.fail(`Could not load model "${name}"`);
      throw err;
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
      `${target.switchedFrom} has no ${String(model.info.runtime?.deviceType ?? model.info.deviceType)} build on this machine, so using ${name} to run on the accelerator. ` +
        `(Set TRACEFORGE_MODEL to choose a model yourself, or TRACEFORGE_DEVICE=cpu to stay on the CPU.)`
    );
  }

  try {
    await downloadAndLoad(model, name);
  } catch (err) {
    // An accelerated build can fail to load (driver, memory, unsupported op). Don't strand the user: use the CPU build.
    const cpu = model.variants.find((v) => String(v.info.deviceType) === "CPU");
    if (!cpu || cpu.id === model.id) throw err;
    logger.warn(`${describeDevice(model.info)} failed (${err instanceof Error ? err.message : String(err)}) — falling back to the CPU build.`);
    model.selectVariant(cpu);
    await downloadAndLoad(model, name);
  }

  const info = model.info;
  logger.ok(`Model "${name}" ready on ${describeDevice(info)}`);
  return { model, info, alias: name, switchedFrom: target.switchedFrom };
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
