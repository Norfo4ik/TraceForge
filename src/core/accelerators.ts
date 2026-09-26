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
      registeredEps.has(v.executionProvider)
  );
  const candidates = force ? runnable.filter((v) => v.deviceType === force) : runnable;
  return [...candidates].sort((a, b) => (RANK[b.deviceType] ?? 0) - (RANK[a.deviceType] ?? 0))[0];
}

/** Execution-provider names that indicate an NPU (Qualcomm QNN, Intel OpenVINO, AMD Vitis AI, generic). */
export function isNpuProvider(name: string): boolean {
  return /qnn|npu|openvino|vitis/i.test(name);
}
