import { FoundryLocalManager, type IModel, type ModelInfo } from "foundry-local-sdk";
import ora from "ora";
import { chooseVariant, parseDevicePreference } from "./accelerators.js";
import { logger } from "../utils/logger.js";

// Namespaces Foundry Local's data on disk. Deliberately NOT renamed with the product: changing it may move the
// model cache and force a multi-GB re-download for no user-visible benefit.
const APP_NAME = "local-devops-copilot";

// Tool-calling-capable and reasonably small (~2.8GB) for fast demo iteration. Read lazily (not at import time)
// so a TRACEFORGE_MODEL set in a .env file — loaded after imports run — is honoured.
// Override with e.g. "qwen2.5-coder-7b" for stronger code understanding.
export function resolveModelAlias(alias?: string): string {
  return alias ?? process.env.TRACEFORGE_MODEL ?? "qwen3-4b";
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
}

export function describeDevice(info: ModelInfo): string {
  const device = info.runtime?.deviceType ?? info.deviceType;
  const provider = info.runtime?.executionProvider ?? info.executionProvider;
  return provider ? `${device} (${provider})` : String(device);
}

/**
 * Downloads and registers every execution provider this machine can use (NPU / GPU runtimes). Opt-in via
 * `doctor --accelerate` because the packages are large; once registered they persist, and model loading
 * then automatically prefers an NPU/GPU variant.
 */
export async function registerAccelerators(
  onProgress: (provider: string, percent: number) => void
): Promise<{ success: boolean; registered: string[]; failed: string[] }> {
  const result = await getManager().downloadAndRegisterEps(onProgress);
  return { success: result.success, registered: [...result.registeredEps], failed: [...result.failedEps] };
}

/** Selects the best runnable variant (NPU > GPU > CPU, or the one forced via TRACEFORGE_DEVICE) on the model. */
function selectBestVariant(model: IModel, alias: string): void {
  const force = parseDevicePreference(process.env.TRACEFORGE_DEVICE);
  if (process.env.TRACEFORGE_DEVICE && !force) {
    logger.warn(`Ignoring TRACEFORGE_DEVICE="${process.env.TRACEFORGE_DEVICE}" (expected npu, gpu or cpu).`);
  }

  const registered = new Set(
    getManager()
      .discoverEps()
      .filter((ep) => ep.isRegistered)
      .map((ep) => ep.name)
  );
  const variants = model.variants;
  const best = chooseVariant(
    variants.map((v) => ({ id: v.id, deviceType: String(v.info.deviceType), executionProvider: v.info.executionProvider })),
    registered,
    force
  );

  if (!best) {
    if (force) {
      logger.warn(`No ${force} variant of "${alias}" is available on this machine — using the default. (Run "traceforge doctor --accelerate" to register NPU/GPU providers.)`);
    }
    return;
  }
  const chosen = variants.find((v) => v.id === best.id);
  if (chosen && chosen.id !== model.id) model.selectVariant(chosen);
}

/** What `ensureModel` would use, without downloading or loading anything — for `doctor`. */
export async function planModel(alias?: string): Promise<{ alias: string; cached: boolean; device: string }> {
  const name = resolveModelAlias(alias);
  const model = await getManager().catalog.getModel(name);
  selectBestVariant(model, name);
  return { alias: name, cached: model.isCached, device: describeDevice(model.info) };
}

/** Ensures the configured model is downloaded and loaded on the best available device, ready for a ChatSession. */
export async function ensureModel(alias?: string): Promise<LoadedModel> {
  const name = resolveModelAlias(alias);
  const model = await getManager().catalog.getModel(name);
  selectBestVariant(model, name);

  if (!model.isCached) {
    const spinner = ora(`Downloading model "${name}" (first run only, this can take a while)...`).start();
    await model.download((pct) => {
      spinner.text = `Downloading model "${name}"... ${Math.round(pct)}%`;
    });
    spinner.succeed(`Model "${name}" downloaded`);
  }

  if (!(await model.isLoaded())) {
    const spinner = ora(`Loading model "${name}" into memory...`).start();
    await model.load();
    spinner.succeed(`Model "${name}" loaded`);
  }

  const info = model.info;
  logger.ok(`Model "${name}" ready on ${describeDevice(info)}`);
  return { model, info };
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
