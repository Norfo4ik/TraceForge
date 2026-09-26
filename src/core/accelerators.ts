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
 * Picks the best model variant that can actually run here: one whose execution provider is registered
 * (CPU always is), preferring NPU over GPU over CPU. `force` restricts to one device type — used to compare
 * devices in a demo. Returns undefined when nothing matches (e.g. forcing NPU on a machine without one).
 */
export function chooseVariant(
  variants: VariantInfo[],
  registeredEps: ReadonlySet<string>,
  force?: DeviceKind
): VariantInfo | undefined {
  const runnable = variants.filter(
    (v) =>
      v.deviceType === "CPU" ||
      !v.executionProvider ||
      v.executionProvider === "CPUExecutionProvider" ||
      providerRegistered(v, registeredEps)
  );
  const candidates = force ? runnable.filter((v) => v.deviceType === force) : runnable;
  return [...candidates].sort((a, b) => (RANK[b.deviceType] ?? 0) - (RANK[a.deviceType] ?? 0))[0];
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

// Best first, for the writing tasks TraceForge does. Anything not listed is ranked by size below.
const PREFERRED_MODELS = ["qwen3-8b", "qwen3-4b", "qwen2.5-7b", "qwen2.5-coder-7b", "phi-4-mini", "qwen2.5-3b", "phi-3.5-mini", "qwen2.5-1.5b"];

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
 * Chooses the model to use when the user hasn't picked one. Keeps `preferredAlias` if it has an NPU/GPU build;
 * otherwise, if the machine has usable accelerators, switches to the best model that does (NPU before GPU) so the
 * hardware isn't left idle. `force` restricts the device; forcing CPU never switches models.
 */
export function pickDefaultModel(
  variants: ModelVariant[],
  registeredEps: ReadonlySet<string>,
  preferredAlias: string,
  force?: DeviceKind
): DefaultModelChoice {
  if (force === "CPU") return { alias: preferredAlias, device: "CPU" };

  const accelerated = acceleratedVariants(variants, registeredEps).filter((v) => !force || v.deviceType === force);
  const byDevice = (a: ModelVariant, b: ModelVariant) => (RANK[b.deviceType] ?? 0) - (RANK[a.deviceType] ?? 0);

  const own = accelerated.filter((v) => v.alias === preferredAlias).sort(byDevice)[0];
  if (own) return { alias: preferredAlias, device: own.deviceType as DeviceKind };
  if (accelerated.length === 0) return { alias: preferredAlias, device: "CPU" };

  const score = (v: ModelVariant) => (RANK[v.deviceType] ?? 0) * 1000 + modelScore(v);
  const best = [...accelerated].sort((a, b) => score(b) - score(a))[0];
  return { alias: best.alias, device: best.deviceType as DeviceKind, switchedFrom: preferredAlias };
}
