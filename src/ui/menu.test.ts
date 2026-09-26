import { describe, expect, it } from "vitest";
import { menuChoices, normalizeOrganization, runMenu, type MenuDeps } from "./menu.js";
import { BackToMenu } from "./prompter.js";
import type { Status } from "./status.js";

class FakeCancel extends Error {
  override name = "ExitPromptError";
}

const configured: Status = {
  repoRoot: "C:/repos/Demo",
  projectRoot: "C:/repos/Demo",
  projectKind: "git",
  config: { organization: "Contoso", project: "Demo", domains: ["work-items"] },
  credentials: true,
  email: "me@example.com",
  model: "qwen3-4b",
  npu: "none",
};

/** A scripted terminal: prompts (of any kind) consume answers in the order they are asked. */
function harness(answers: unknown[], statuses: Status[] = [configured]) {
  const queue = [...answers];
  const next = () => {
    if (queue.length === 0) throw new Error("test script ran out of answers");
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return value;
  };
  const calls: Array<[string, ...unknown[]]> = [];
  const logs: string[] = [];
  let statusIndex = 0;

  const deps: MenuDeps = {
    ui: {
      select: async () => next() as never,
      input: async () => next() as string,
      password: async () => next() as string,
      confirm: async () => next() as boolean,
    },
    status: async () => statuses[Math.min(statusIndex++, statuses.length - 1)],
    draw: () => {},
    actions: {
      investigate: async (id, opts) => void calls.push(["investigate", id, opts]),
      docs: async () => void calls.push(["docs"]),
      ask: async (q) => void calls.push(["ask", q]),
      init: async (opts) => void calls.push(["init", opts]),
      doctor: async (opts) => void calls.push(["doctor", opts]),
      saveCredentials: (email, pat) => {
        calls.push(["saveCredentials", email, pat]);
        return "/home/me/.traceforge/.env";
      },
      setAccelerators: (enabled) => void calls.push(["setAccelerators", enabled]),
      prepareModel: async (alias) => void calls.push(["prepareModel", alias]),
    },
    log: {
      ok: (m) => void logs.push(`ok: ${m}`),
      info: (m) => void logs.push(`info: ${m}`),
      warn: (m) => void logs.push(`warn: ${m}`),
      error: (m) => void logs.push(`error: ${m}`),
    },
  };
  return { deps, calls, logs, remaining: () => queue.length };
}

describe("runMenu", () => {
  it("exits straight away when Exit is chosen", async () => {
    const h = harness(["exit"]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([]);
  });

  it("investigates a work item: asks for the id, then whether to post a comment", async () => {
    const h = harness(["investigate", " 42 ", false, "", "exit"]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([["investigate", "42", { postComment: false }]]);
    expect(h.remaining()).toBe(0);
  });

  it("does nothing further when the user declines to set up Azure DevOps first", async () => {
    const h = harness(["investigate", false, "", "exit"], [{ ...configured, config: undefined }]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([]);
  });

  it("offers setup when the repo isn't configured, then carries on to the investigation", async () => {
    const unconfigured: Status = { ...configured, config: undefined };
    const h = harness(
      ["investigate", true, "https://dev.azure.com/Contoso/", "Demo", true, false, "7", true, "", "exit"],
      [unconfigured, configured] // 1st read draws the menu; the 2nd is the re-read right after setup
    );
    await runMenu(h.deps);
    expect(h.calls).toEqual([
      ["init", { org: "Contoso", project: "Demo", skipDocs: false, vscode: false }],
      ["investigate", "7", { postComment: true }],
    ]);
  });

  it("shows an action's error and returns to the menu instead of crashing", async () => {
    const h = harness(["docs", "", "exit"]);
    h.deps.actions.docs = async () => {
      throw new Error("model produced unusable output");
    };
    await runMenu(h.deps);
    expect(h.logs).toContain("error: model produced unusable output");
    expect(h.remaining()).toBe(0);
  });

  it("treats Ctrl+C at the menu as a clean exit", async () => {
    const h = harness([new FakeCancel("cancelled")]);
    await expect(runMenu(h.deps)).resolves.toBeUndefined();
  });

  it("treats Ctrl+C inside a flow as a clean exit", async () => {
    const h = harness(["ask", new FakeCancel("cancelled")]);
    await expect(runMenu(h.deps)).resolves.toBeUndefined();
    expect(h.calls).toEqual([]);
  });

  it("Esc in the work item id prompt goes straight back to the menu, with no error and no pause", async () => {
    const h = harness(["investigate", new BackToMenu(), "exit"]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([]);
    expect(h.remaining()).toBe(0); // the "press Enter" prompt was skipped
  });

  it("Esc part-way through setup abandons it without running init", async () => {
    const h = harness(["setup", "Contoso", new BackToMenu(), "exit"]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it("Esc at the 'press Enter to return' pause still returns to the menu", async () => {
    const h = harness(["doctor", new BackToMenu(), "exit"]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([["doctor", { checkAdo: true }]]);
    expect(h.remaining()).toBe(0);
  });

  it("saves credentials from the connect flow and offers a connection test", async () => {
    const h = harness(["connect", " me@example.com ", " secret-token ", true, "", "exit"]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([
      ["saveCredentials", "me@example.com", "secret-token"],
      ["doctor", { checkAdo: true }],
    ]);
  });

  it("saves nothing when the token is left empty", async () => {
    const h = harness(["connect", "me@example.com", "   ", "", "exit"]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([]);
    expect(h.logs.some((l) => l.startsWith("warn: No token"))).toBe(true);
  });

  it("only downloads accelerators after an explicit yes", async () => {
    const declined = harness(["accelerate", false, "", "exit"]);
    await runMenu(declined.deps);
    expect(declined.calls).toEqual([]);

    const accepted = harness(["accelerate", true, "", "exit"]);
    await runMenu(accepted.deps);
    expect(accepted.calls).toEqual([["doctor", { accelerate: true }]]);
  });
});

describe("first-launch NPU offer", () => {
  const npuFound: Status = { ...configured, npu: "available", acceleratorDecision: undefined };
  const npuOn: Status = { ...configured, npu: "registered", acceleratorDecision: true };

  it("enables acceleration when the user says yes, then shows the updated state", async () => {
    const h = harness([true, "", "exit"], [npuFound, npuOn]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([["doctor", { accelerate: true }]]);
    expect(h.remaining()).toBe(0);
  });

  it("remembers a no, and asks only once per session even if the state stays 'undecided'", async () => {
    const h = harness([false, "", "exit"], [npuFound]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([["setAccelerators", false]]);
    expect(h.logs.some((l) => l.includes("staying on the CPU"))).toBe(true);
  });

  it("Esc means 'not now': nothing is saved or downloaded", async () => {
    const h = harness([new BackToMenu(), "exit"], [npuFound]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it.each([
    ["already decided", { ...npuFound, acceleratorDecision: false }],
    ["already enabled", npuOn],
    ["no NPU on this machine", { ...npuFound, npu: "none" as const }],
  ])("does not ask when %s", async (_name, status) => {
    const h = harness(["exit"], [status]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([]);
  });
});

describe("first-launch model download offer", () => {
  const notDownloaded: Status = { ...configured, model: "phi-4-mini", modelCached: false, modelSizeMb: 2200 };
  const downloaded: Status = { ...notDownloaded, modelCached: true };

  it("downloads and loads the model up front when the user says yes", async () => {
    const h = harness([true, "", "exit"], [notDownloaded, downloaded]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([["prepareModel", undefined]]);
    expect(h.remaining()).toBe(0);
  });

  it("does nothing on no — it downloads on first use instead — and doesn't ask again this session", async () => {
    const h = harness([false, "exit"], [notDownloaded]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([]);
    expect(h.remaining()).toBe(0);
  });

  it("Esc means not now", async () => {
    const h = harness([new BackToMenu(), "exit"], [notDownloaded]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it("shows a failed preparation as a message, not a crash, and returns to the menu", async () => {
    const h = harness([true, "", "exit"], [notDownloaded]);
    h.deps.actions.prepareModel = async () => {
      throw new Error("phi-4-mini could not be loaded on any available device");
    };
    await runMenu(h.deps);
    expect(h.logs).toContain("error: phi-4-mini could not be loaded on any available device");
    expect(h.remaining()).toBe(0);
  });

  it("does not ask when the model is already downloaded or unknown", async () => {
    const cached = harness(["exit"], [downloaded]);
    await runMenu(cached.deps);
    expect(cached.calls).toEqual([]);
    const unknown = harness(["exit"], [{ ...notDownloaded, modelCached: undefined }]);
    await runMenu(unknown.deps);
    expect(unknown.calls).toEqual([]);
  });

  it("asks about the NPU first, then about the download", async () => {
    const npuFound: Status = { ...notDownloaded, npu: "available", acceleratorDecision: undefined };
    const npuOn: Status = { ...notDownloaded, npu: "registered", acceleratorDecision: true };
    const h = harness([true, "", true, "", "exit"], [npuFound, npuOn, { ...npuOn, modelCached: true }]);
    await runMenu(h.deps);
    expect(h.calls).toEqual([["doctor", { accelerate: true }], ["prepareModel", undefined]]);
  });
});

describe("menuChoices", () => {
  it("disables every code-related action outside a git repository (Ask would only invent a project), but keeps sign-in and health checks", () => {
    const choices = menuChoices({ credentials: false, model: "qwen3-4b", npu: "none" });
    const byValue = Object.fromEntries(choices.map((c) => [c.value, c]));
    for (const value of ["investigate", "docs", "ask", "setup"]) expect(byValue[value].disabled).toBeTruthy();
    expect(byValue.connect.disabled).toBeFalsy();
    expect(byValue.doctor.disabled).toBeFalsy();
    expect(byValue.accelerate.disabled).toBeFalsy();
    expect(byValue.connect.name).toBe("Connect Azure DevOps");
  });

  it("enables Ask inside a repository", () => {
    expect(menuChoices(configured).find((c) => c.value === "ask")!.disabled).toBeFalsy();
  });

  it("enables Ask in a plain project folder (no git), while Investigate, Docs and Setup still need a repository", () => {
    const folder: Status = { credentials: true, model: "qwen3-4b", npu: "none", projectRoot: "C:/work/MyApp", projectKind: "folder" };
    const byValue = Object.fromEntries(menuChoices(folder).map((c) => [c.value, c]));
    expect(byValue.ask.disabled).toBeFalsy();
    for (const value of ["investigate", "docs", "setup"]) expect(byValue[value].disabled).toBeTruthy();
  });

  it("offers to update the sign-in once credentials exist", () => {
    const connect = menuChoices(configured).find((c) => c.value === "connect")!;
    expect(connect.name).toBe("Update Azure DevOps sign-in");
  });
});

describe("normalizeOrganization", () => {
  it.each([
    ["Contoso", "Contoso"],
    ["  Contoso  ", "Contoso"],
    ["https://dev.azure.com/Contoso/", "Contoso"],
    ["https://dev.azure.com/Contoso/Project", "Contoso"],
    ["https://contoso.visualstudio.com/", "contoso"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeOrganization(input)).toBe(expected);
  });
});
