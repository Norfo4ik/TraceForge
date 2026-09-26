import { describe, expect, it } from "vitest";
import {
  acceleratedVariants,
  chooseVariant,
  isChatModelAlias,
  isNpuProvider,
  parseDevicePreference,
  pickDefaultModel,
  type ModelVariant,
  type VariantInfo,
} from "./accelerators.js";

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

const mv = (alias: string, deviceType: string, executionProvider: string, extra: Partial<ModelVariant> = {}): ModelVariant => ({
  alias,
  id: `${alias}-${deviceType.toLowerCase()}`,
  deviceType,
  executionProvider,
  ...extra,
});
const OV = "OpenVINOExecutionProvider";
const WEBGPU = "WebGpuExecutionProvider";

describe("pickDefaultModel", () => {
  const catalog: ModelVariant[] = [
    mv("qwen3-4b", "CPU", "CPUExecutionProvider"),
    mv("phi-3.5-mini", "CPU", "CPUExecutionProvider"),
    mv("phi-3.5-mini", "NPU", OV, { fileSizeMb: 2500 }),
    mv("phi-3.5-mini", "GPU", WEBGPU, { fileSizeMb: 2500 }),
    mv("qwen2.5-1.5b", "NPU", OV, { fileSizeMb: 1800, supportsToolCalling: true }),
    mv("whisper-tiny", "NPU", OV),
  ];

  it("keeps the usual default when it has an accelerated build", () => {
    const withOwn = [...catalog, mv("qwen3-4b", "NPU", OV, { fileSizeMb: 2800 })];
    expect(pickDefaultModel(withOwn, new Set([OV]), "qwen3-4b")).toEqual({ alias: "qwen3-4b", device: "NPU" });
  });

  it("switches to the best model that can use the NPU when the default has no NPU build", () => {
    const choice = pickDefaultModel(catalog, new Set([OV, WEBGPU]), "qwen3-4b");
    expect(choice).toEqual({ alias: "phi-3.5-mini", device: "NPU", switchedFrom: "qwen3-4b" });
  });

  it("prefers the NPU over the GPU, but uses the GPU when that is all that is registered", () => {
    expect(pickDefaultModel(catalog, new Set([OV, WEBGPU]), "qwen3-4b").device).toBe("NPU");
    expect(pickDefaultModel(catalog, new Set([WEBGPU]), "qwen3-4b")).toEqual({ alias: "phi-3.5-mini", device: "GPU", switchedFrom: "qwen3-4b" });
  });

  it("stays on the default CPU model when no accelerator is registered", () => {
    expect(pickDefaultModel(catalog, new Set(), "qwen3-4b")).toEqual({ alias: "qwen3-4b", device: "CPU" });
  });

  it("never switches models when CPU is forced", () => {
    expect(pickDefaultModel(catalog, new Set([OV]), "qwen3-4b", "CPU")).toEqual({ alias: "qwen3-4b", device: "CPU" });
  });

  it("honours a forced GPU and never picks speech or embedding models", () => {
    expect(pickDefaultModel(catalog, new Set([OV, WEBGPU]), "qwen3-4b", "GPU").device).toBe("GPU");
    const onlySpeech = [mv("whisper-tiny", "NPU", OV)];
    expect(pickDefaultModel(onlySpeech, new Set([OV]), "qwen3-4b")).toEqual({ alias: "qwen3-4b", device: "CPU" });
  });

  it("ranks unlisted models by size", () => {
    const unlisted = [mv("small-x", "NPU", OV, { fileSizeMb: 900 }), mv("big-y", "NPU", OV, { fileSizeMb: 5000 })];
    expect(pickDefaultModel(unlisted, new Set([OV]), "qwen3-4b").alias).toBe("big-y");
  });
});

describe("provider name matching", () => {
  it("matches provider names loosely, so a catalog naming quirk can't hide an accelerator", () => {
    const quirky = [mv("phi-3.5-mini", "NPU", "OpenVINO")];
    expect(acceleratedVariants(quirky, new Set([OV])).map((v) => v.alias)).toEqual(["phi-3.5-mini"]);
    expect(chooseVariant([{ id: "x-cpu", deviceType: "CPU" }, { id: "x-npu", deviceType: "NPU", executionProvider: "openvino" }], new Set([OV]))?.id).toBe("x-npu");
  });

  it("counts an NPU build that names no provider when an NPU provider is registered, but not otherwise", () => {
    const unnamed: ModelVariant[] = [{ alias: "phi-3.5-mini", id: "p-npu", deviceType: "NPU" }];
    expect(acceleratedVariants(unnamed, new Set([OV]))).toHaveLength(1);
    expect(acceleratedVariants(unnamed, new Set([WEBGPU]))).toHaveLength(0);
    expect(acceleratedVariants(unnamed, new Set())).toHaveLength(0);
  });

  it("still does not treat an unregistered provider as usable", () => {
    expect(acceleratedVariants([mv("a", "NPU", OV)], new Set([WEBGPU]))).toHaveLength(0);
  });
});

describe("acceleratedVariants / isChatModelAlias", () => {
  it("only returns non-CPU builds whose provider is registered", () => {
    const all = [mv("a", "NPU", OV), mv("b", "GPU", WEBGPU), mv("c", "CPU", "CPUExecutionProvider")];
    expect(acceleratedVariants(all, new Set([OV])).map((v) => v.alias)).toEqual(["a"]);
  });

  it("filters out non-chat models", () => {
    expect(["whisper-base", "qwen3-embedding-8b", "parakeet-tdt-0.6b-v2", "qwen3-vl-4b-instruct"].some(isChatModelAlias)).toBe(false);
    expect(isChatModelAlias("phi-3.5-mini")).toBe(true);
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
