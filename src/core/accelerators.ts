export type DeviceKind = "NPU" | "GPU" | "CPU";

export interface VariantInfo {
  id: string;
  deviceType: string;
  executionProvider?: string;
}

const RANK: Record<string, number> = { NPU: 3, GPU: 2, CPU: 1 };

export function parseDevicePreference(value: string | undefined): DeviceKind | undefined {
  const v = value?.trim().toUpperCase();
  return v === "NPU" || v === "GPU" || v === "CPU" ? v : undefined;
}

/**
 * The builds of one model that can actually run here, best first: execution provider registered (CPU always is),
 * NPU before GPU before CPU. `force` restricts to one device type — used to compare devices in a demo — and
 * `blocked` skips builds that failed to load before. The order is also the fallback order when a load fails.
 */
export function rankVariants(
  variants: VariantInfo[],
  registeredEps: ReadonlySet<string>,
  force?: DeviceKind,
  blocked: ReadonlySet<string> = new Set()
): VariantInfo[] {
  const runnable = variants.filter(
    (v) =>
      !blocked.has(v.id) &&
      (v.deviceType === "CPU" ||
        !v.executionProvider ||
        v.executionProvider === "CPUExecutionProvider" ||
        providerRegistered(v, registeredEps))
  );
  const candidates = force ? runnable.filter((v) => v.deviceType === force) : runnable;
  return [...candidates].sort((a, b) => (RANK[b.deviceType] ?? 0) - (RANK[a.deviceType] ?? 0));
}

/** The best runnable build, or undefined when nothing matches (e.g. forcing NPU on a machine without one). */
export function chooseVariant(
  variants: VariantInfo[],
  registeredEps: ReadonlySet<string>,
  force?: DeviceKind,
  blocked: ReadonlySet<string> = new Set()
): VariantInfo | undefined {
  return rankVariants(variants, registeredEps, force, blocked)[0];
}

export interface FallbackHooks<T> {
  describe(build: T): { id: string; device: string; cached: boolean };
  /** True when `err` happened while loading the model (as opposed to downloading it). */
  isLoadError(err: unknown): boolean;
  /** A build failed to load; `next` is what will be tried instead (undefined when nothing is left). */
  onLoadFailure(build: T, err: unknown, next: T | undefined): void;
  /** A download failed; `next` is the next build that is already on disk. */
  onDownloadFailure(build: T, err: unknown, next: T | undefined): void;
}

/**
 * Tries the builds in order until one loads. A load failure moves on to the next (lower) device. A download failure
 * (offline, disk full) can only be helped by a build that's already on disk, so builds that would need a download are
 * skipped; if there's none, it stops. Pure so every path can be tested without hardware.
 */
export async function loadWithFallback<T>(
  builds: T[],
  attempt: (build: T) => Promise<void>,
  hooks: FallbackHooks<T>
): Promise<{ used: T } | { error: unknown }> {
  const queue = [...builds];
  let lastError: unknown = new Error("no build of the model can run on this machine");
  while (queue.length > 0) {
    const build = queue.shift() as T;
    try {
      await attempt(build);
      return { used: build };
    } catch (err) {
      lastError = err;
      if (hooks.isLoadError(err)) {
        hooks.onLoadFailure(build, err, queue[0]);
      } else {
        const onDisk = queue.findIndex((b) => hooks.describe(b).cached);
        if (onDisk === -1) return { error: err };
        queue.splice(0, onDisk);
        hooks.onDownloadFailure(build, err, queue[0]);
      }
    }
  }
  return { error: lastError };
}

export interface LoadFailure {
  /** One plain-English sentence: what went wrong. */
  summary: string;
  /** What the user can do about it, when we know. */
  hint?: string;
}

/**
 * Turns a native model-load error (a wall of stack-like text from the inference runtime) into something a person can
 * act on. The NPU case is real, from an Intel Core Ultra PC: the model's NPU build was compiled for a newer NPU
 * compiler interface (8.2) than the installed NPU driver supports (8.1).
 */
export function explainLoadFailure(message: string): LoadFailure {
  const npuApi = /API version[^\n]*?Found:\s*([\d.]+?)\.?\s+Expected:\s*([\d.]+)/i.exec(message);
  if (npuApi) {
    return {
      summary: `the NPU driver on this PC is older than this model build needs (built for NPU compiler API ${npuApi[1]}, driver supports ${npuApi[2]})`,
      hint: 'Update the Intel NPU driver (Windows Update → Advanced options → Optional updates, or your PC maker\'s / Intel\'s driver page), restart, then choose "Enable NPU / GPU acceleration" to try again.',
    };
  }
  if (/out of memory|bad_alloc|insufficient memory|not enough memory/i.test(message)) {
    return { summary: "there isn't enough free memory to load this model", hint: "Close other applications, or pick a smaller model with TRACEFORGE_MODEL." };
  }
  const firstLine = message.split("\n").map((l) => l.trim()).find(Boolean) ?? "unknown error";
  return { summary: firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine };
}

/** Execution-provider names that indicate an NPU (Qualcomm QNN, Intel OpenVINO, AMD Vitis AI, generic). */
export function isNpuProvider(name: string): boolean {
  return /qnn|npu|openvino|vitis/i.test(name);
}

/** One concrete build of a model in the catalog (a model alias can have CPU, GPU and NPU builds). */
export interface ModelVariant extends VariantInfo {
  alias: string;
  fileSizeMb?: number;
  supportsToolCalling?: boolean;
}

/** Speech, embedding and vision models are in the same catalog but can't write a report. */
export function isChatModelAlias(alias: string): boolean {
  return !/whisper|parakeet|nemotron|embedding|speech|asr|-vl-|rerank/i.test(alias);
}

// Best first, for the writing tasks TraceForge does. phi-4-mini is ahead of the 7B models because on an NPU a
// ~4B model is far more responsive, and it follows instructions and calls tools well. Unlisted models are ranked by size.
const PREFERRED_MODELS = ["qwen3-8b", "qwen3-4b", "phi-4-mini", "qwen2.5-7b", "qwen2.5-coder-7b", "qwen2.5-3b", "phi-3.5-mini", "qwen2.5-1.5b"];

/** Execution providers that aren't registered yet — the ones to download and register at startup. */
export function unregisteredProviders(eps: ReadonlyArray<{ name: string; isRegistered: boolean }>): string[] {
  return eps.filter((ep) => !ep.isRegistered).map((ep) => ep.name);
}

function modelScore(v: ModelVariant): number {
  const listed = PREFERRED_MODELS.indexOf(v.alias);
  const quality = listed >= 0 ? (PREFERRED_MODELS.length - listed) * 10 : Math.min((v.fileSizeMb ?? 0) / 1000, 9);
  return quality + (v.supportsToolCalling ? 5 : 0);
}

const normalizeProvider = (name: string) => name.toLowerCase().replace(/executionprovider$/, "");

/**
 * Is this build's execution provider registered? Names are compared loosely ("OpenVINO" matches
 * "OpenVINOExecutionProvider"), and a build that names no provider counts for an NPU when any NPU provider is
 * registered — so a naming quirk in the catalog can't silently hide an accelerator from the user.
 */
function providerRegistered(v: VariantInfo, registeredEps: ReadonlySet<string>): boolean {
  if (v.executionProvider) {
    const wanted = normalizeProvider(v.executionProvider);
    return [...registeredEps].some((name) => normalizeProvider(name) === wanted);
  }
  return v.deviceType === "NPU" && [...registeredEps].some(isNpuProvider);
}

/**
 * Registered runtimes that no model in the catalog references. On real hardware the catalog once listed 1 model
 * after a startup registration but 35 (with NPU builds) after `--accelerate`, with the same runtimes "registered" —
 * a registered runtime with zero builds means the catalog didn't pick the registration up.
 */
export function providersWithoutBuilds(registeredEps: ReadonlySet<string>, variants: ModelVariant[]): string[] {
  const used = new Set(variants.flatMap((v) => (v.executionProvider ? [normalizeProvider(v.executionProvider)] : [])));
  return [...registeredEps].filter((name) => name !== "CPUExecutionProvider" && !used.has(normalizeProvider(name)));
}

/** One line per accelerator runtime: how many NPU/GPU builds the catalog offers for it. For `doctor`. */
export function summarizeBuilds(variants: ModelVariant[]): string[] {
  const byProvider = new Map<string, Map<string, number>>();
  for (const v of variants) {
    if (v.deviceType === "CPU") continue;
    const provider = v.executionProvider ?? "(unnamed provider)";
    const devices = byProvider.get(provider) ?? new Map<string, number>();
    devices.set(v.deviceType, (devices.get(v.deviceType) ?? 0) + 1);
    byProvider.set(provider, devices);
  }
  return [...byProvider].map(([provider, devices]) => `${provider}: ${[...devices].map(([d, n]) => `${d} ×${n}`).join(", ")}`);
}

/** Builds that can run on an accelerator right now: not CPU, and their execution provider is registered. */
export function acceleratedVariants(variants: ModelVariant[], registeredEps: ReadonlySet<string>): ModelVariant[] {
  return variants.filter((v) => v.deviceType !== "CPU" && providerRegistered(v, registeredEps) && isChatModelAlias(v.alias));
}

export interface DefaultModelChoice {
  alias: string;
  device: DeviceKind;
  /** Set when the usual default has no accelerated build here, so another model was chosen to use the NPU/GPU. */
  switchedFrom?: string;
}

/**
 * Chooses the model to use when the user hasn't picked one. Device first: use the best accelerator that has any
 * usable model (NPU, then GPU). Within that device keep `preferredAlias` if it has a build there, otherwise take the
 * best model that does — so a default with only a GPU build doesn't keep the machine off an available NPU.
 * `force` restricts the device; forcing CPU never switches models.
 */
export function pickDefaultModel(
  variants: ModelVariant[],
  registeredEps: ReadonlySet<string>,
  preferredAlias: string,
  force?: DeviceKind
): DefaultModelChoice {
  if (force === "CPU") return { alias: preferredAlias, device: "CPU" };

  const accelerated = acceleratedVariants(variants, registeredEps).filter((v) => !force || v.deviceType === force);
  if (accelerated.length === 0) return { alias: preferredAlias, device: "CPU" };

  const bestRank = Math.max(...accelerated.map((v) => RANK[v.deviceType] ?? 0));
  const onBestDevice = accelerated.filter((v) => (RANK[v.deviceType] ?? 0) === bestRank);

  const own = onBestDevice.find((v) => v.alias === preferredAlias);
  if (own) return { alias: preferredAlias, device: own.deviceType as DeviceKind };

  const best = [...onBestDevice].sort((a, b) => modelScore(b) - modelScore(a))[0];
  return { alias: best.alias, device: best.deviceType as DeviceKind, switchedFrom: preferredAlias };
}
