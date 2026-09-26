import { describe, expect, it } from "vitest";
import { chooseVariant, isNpuProvider, parseDevicePreference, type VariantInfo } from "./accelerators.js";

const cpu: VariantInfo = { id: "m-cpu", deviceType: "CPU", executionProvider: "CPUExecutionProvider" };
const gpu: VariantInfo = { id: "m-gpu", deviceType: "GPU", executionProvider: "CUDAExecutionProvider" };
const npu: VariantInfo = { id: "m-npu", deviceType: "NPU", executionProvider: "QNNExecutionProvider" };

describe("chooseVariant", () => {
  it("prefers NPU, then GPU, then CPU among runnable variants", () => {
    const eps = new Set(["QNNExecutionProvider", "CUDAExecutionProvider"]);
    expect(chooseVariant([cpu, gpu, npu], eps)?.id).toBe("m-npu");
    expect(chooseVariant([cpu, gpu], eps)?.id).toBe("m-gpu");
    expect(chooseVariant([cpu], eps)?.id).toBe("m-cpu");
  });

  it("ignores accelerated variants whose provider is not registered", () => {
    expect(chooseVariant([cpu, gpu, npu], new Set())?.id).toBe("m-cpu");
    expect(chooseVariant([cpu, gpu, npu], new Set(["CUDAExecutionProvider"]))?.id).toBe("m-gpu");
  });

  it("honours a forced device and returns undefined when it is unavailable", () => {
    const eps = new Set(["QNNExecutionProvider"]);
    expect(chooseVariant([cpu, npu], eps, "CPU")?.id).toBe("m-cpu");
    expect(chooseVariant([cpu, npu], eps, "GPU")).toBeUndefined();
  });
});

describe("device helpers", () => {
  it("parses TRACEFORGE_DEVICE case-insensitively and rejects junk", () => {
    expect(parseDevicePreference("npu")).toBe("NPU");
    expect(parseDevicePreference(" Cpu ")).toBe("CPU");
    expect(parseDevicePreference("tpu")).toBeUndefined();
    expect(parseDevicePreference(undefined)).toBeUndefined();
  });

  it("recognises NPU execution providers", () => {
    expect(isNpuProvider("QNNExecutionProvider")).toBe(true);
    expect(isNpuProvider("OpenVINOExecutionProvider")).toBe(true);
    expect(isNpuProvider("CUDAExecutionProvider")).toBe(false);
  });
});
