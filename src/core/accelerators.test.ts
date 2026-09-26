import { describe, expect, it } from "vitest";
import {
  acceleratedVariants,
  chooseVariant,
  explainLoadFailure,
  loadWithFallback,
  rankVariants,
  isChatModelAlias,
  isNpuProvider,
  parseDevicePreference,
  pickDefaultModel,
  providersWithoutBuilds,
  summarizeBuilds,
  unregisteredProviders,
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

  it("goes NPU-first even when the default model only has a GPU build (the real catalog on an Intel Core Ultra)", () => {
    const real: ModelVariant[] = [
      mv("qwen3-4b", "GPU", WEBGPU, { fileSizeMb: 2900, supportsToolCalling: true }),
      mv("phi-4-mini", "NPU", OV, { fileSizeMb: 2200, supportsToolCalling: true }),
      mv("phi-4-mini", "GPU", WEBGPU, { fileSizeMb: 2200, supportsToolCalling: true }),
      mv("qwen2.5-7b", "NPU", OV, { fileSizeMb: 4300, supportsToolCalling: true }),
      mv("deepseek-r1-7b", "NPU", OV, { fileSizeMb: 4300 }),
    ];
    expect(pickDefaultModel(real, new Set([OV, WEBGPU]), "qwen3-4b")).toEqual({ alias: "phi-4-mini", device: "NPU", switchedFrom: "qwen3-4b" });
    // Asking for the GPU explicitly keeps the usual model, which is what a CPU/GPU/NPU comparison needs.
    expect(pickDefaultModel(real, new Set([OV, WEBGPU]), "qwen3-4b", "GPU")).toEqual({ alias: "qwen3-4b", device: "GPU" });
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

describe("rankVariants (fallback order)", () => {
  const cpu: VariantInfo = { id: "m-cpu", deviceType: "CPU", executionProvider: "CPUExecutionProvider" };
  const gpu: VariantInfo = { id: "m-gpu", deviceType: "GPU", executionProvider: WEBGPU };
  const npu: VariantInfo = { id: "m-npu", deviceType: "NPU", executionProvider: OV };
  const eps = new Set([OV, WEBGPU]);

  it("orders NPU, GPU, CPU so a failed load can fall back down the list", () => {
    expect(rankVariants([cpu, gpu, npu], eps).map((v) => v.id)).toEqual(["m-npu", "m-gpu", "m-cpu"]);
  });

  it("skips builds that failed before, so the next start doesn't retry them", () => {
    expect(rankVariants([cpu, gpu, npu], eps, undefined, new Set(["m-npu"])).map((v) => v.id)).toEqual(["m-gpu", "m-cpu"]);
    expect(chooseVariant([cpu, gpu, npu], eps, undefined, new Set(["m-npu", "m-gpu"]))?.id).toBe("m-cpu");
  });
});

describe("loadWithFallback", () => {
  interface B { id: string; device: string; cached: boolean }
  class LoadErr extends Error {}
  const builds: B[] = [
    { id: "npu", device: "NPU", cached: false },
    { id: "gpu", device: "GPU", cached: false },
    { id: "cpu", device: "CPU", cached: true },
  ];

  function run(failures: Record<string, Error>) {
    const events: string[] = [];
    const tried: string[] = [];
    const promise = loadWithFallback(
      builds,
      async (b) => {
        tried.push(b.id);
        if (failures[b.id]) throw failures[b.id];
      },
      {
        describe: (b) => b,
        isLoadError: (e) => e instanceof LoadErr,
        onLoadFailure: (b, _e, next) => void events.push(`load-failed:${b.id}->${next?.id ?? "none"}`),
        onDownloadFailure: (b, _e, next) => void events.push(`download-failed:${b.id}->${next?.id ?? "none"}`),
      }
    );
    return { promise, events, tried };
  }

  it("uses the first build when it loads", async () => {
    const r = run({});
    expect(await r.promise).toEqual({ used: builds[0] });
    expect(r.tried).toEqual(["npu"]);
  });

  it("falls back from a failed NPU load to the GPU, then reports what it dropped", async () => {
    const r = run({ npu: new LoadErr("driver too old") });
    expect(await r.promise).toEqual({ used: builds[1] });
    expect(r.events).toEqual(["load-failed:npu->gpu"]);
  });

  it("keeps going down to the CPU when NPU and GPU both fail to load", async () => {
    const r = run({ npu: new LoadErr("a"), gpu: new LoadErr("b") });
    expect(await r.promise).toEqual({ used: builds[2] });
    expect(r.tried).toEqual(["npu", "gpu", "cpu"]);
    expect(r.events).toEqual(["load-failed:npu->gpu", "load-failed:gpu->cpu"]);
  });

  it("returns the error when every build fails to load", async () => {
    const boom = new LoadErr("cpu too");
    const r = run({ npu: new LoadErr("a"), gpu: new LoadErr("b"), cpu: boom });
    expect(await r.promise).toEqual({ error: boom });
    expect(r.events.at(-1)).toBe("load-failed:cpu->none");
  });

  it("after a failed download, skips straight to a build already on disk instead of downloading another", async () => {
    const r = run({ npu: new Error("offline") });
    expect(await r.promise).toEqual({ used: builds[2] });
    expect(r.tried).toEqual(["npu", "cpu"]);
    expect(r.events).toEqual(["download-failed:npu->cpu"]);
  });

  it("stops with the download error when nothing on disk can help", async () => {
    const offline = new Error("offline");
    const uncached: B[] = [{ id: "a", device: "NPU", cached: false }, { id: "b", device: "GPU", cached: false }];
    const result = await loadWithFallback(uncached, async () => { throw offline; }, {
      describe: (b) => b,
      isLoadError: () => false,
      onLoadFailure: () => {},
      onDownloadFailure: () => {},
    });
    expect(result).toEqual({ error: offline });
  });

  it("handles an empty list without throwing", async () => {
    const result = await loadWithFallback([], async () => {}, { describe: (b: B) => b, isLoadError: () => false, onLoadFailure: () => {}, onDownloadFailure: () => {} });
    expect("error" in result).toBe(true);
  });
});

describe("explainLoadFailure", () => {
  const realNpuError =
    "genai_model_instance.cc:59 fl::GenAIModelInstance::GenAIModelInstance failed to load model phi-4-mini-instruct-openvino-npu:4: Exception from src\\inference\\src\\cpp\\core.cpp:120:\n" +
    "Exception from src\\plugins\\intel_npu\\src\\compiler_adapter\\src\\ze_graph_ext_wrappers.cpp:433:\n" +
    "Compilation failed. Level0 pfnCreate2 result: ZE_RESULT_ERROR_INVALID_NULL_POINTER, code 0x78000007 - pointer argument may not be nullptr . [NPU_VCL] The API version found in the serialized model is not supported. Found: 8.2. Expected: 8.1\n" +
    "[NPU_VCL] Failed to parse model info! Incorrect format!";

  it("explains the real NPU driver-too-old failure and says how to fix it", () => {
    const f = explainLoadFailure(realNpuError);
    expect(f.summary).toContain("NPU driver on this PC is older");
    expect(f.summary).toContain("8.2");
    expect(f.summary).toContain("8.1");
    expect(f.hint).toContain("Update the Intel NPU driver");
    expect(f.summary).not.toContain("Exception from");
  });

  it("recognises out-of-memory", () => {
    expect(explainLoadFailure("std::bad_alloc").summary).toContain("enough free memory");
  });

  it("falls back to a short first line for unknown errors instead of dumping everything", () => {
    const f = explainLoadFailure("\n  Something odd happened\nwith a long\nstack");
    expect(f.summary).toBe("Something odd happened");
    expect(f.hint).toBeUndefined();
    expect(explainLoadFailure("x".repeat(500)).summary.length).toBeLessThan(200);
  });
});

describe("catalog self-check", () => {
  it("flags a registered runtime that no build in the catalog uses (a stale catalog)", () => {
    const stale = [mv("deepseek-r1-1.5b", "GPU", OV), mv("qwen3-4b", "CPU", "CPUExecutionProvider")];
    expect(providersWithoutBuilds(new Set([OV, WEBGPU]), stale)).toEqual([WEBGPU]);
  });

  it("is quiet when every registered runtime has builds, matching names loosely", () => {
    const full = [mv("a", "NPU", "OpenVINO"), mv("b", "GPU", WEBGPU)];
    expect(providersWithoutBuilds(new Set([OV, WEBGPU]), full)).toEqual([]);
    expect(providersWithoutBuilds(new Set(), full)).toEqual([]);
  });

  it("summarises builds per runtime and ignores CPU builds", () => {
    const v = [mv("a", "NPU", OV), mv("b", "NPU", OV), mv("c", "GPU", OV), mv("d", "GPU", WEBGPU), mv("e", "CPU", "CPUExecutionProvider")];
    expect(summarizeBuilds(v)).toEqual([`${OV}: NPU ×2, GPU ×1`, `${WEBGPU}: GPU ×1`]);
    expect(summarizeBuilds([mv("e", "CPU", "CPUExecutionProvider")])).toEqual([]);
  });
});

describe("unregisteredProviders", () => {
  it("lists only the providers that still need registering", () => {
    const eps = [
      { name: "OpenVINOExecutionProvider", isRegistered: false },
      { name: "WebGpuExecutionProvider", isRegistered: true },
    ];
    expect(unregisteredProviders(eps)).toEqual(["OpenVINOExecutionProvider"]);
    expect(unregisteredProviders([])).toEqual([]);
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
