import ora from "ora";
import { runAsk } from "../commands/ask.js";
import { runDocs } from "../commands/docs.js";
import { runDoctor, type DoctorOptions } from "../commands/doctor.js";
import { runInit, type InitOptions } from "../commands/init.js";
import { runInvestigate, type InvestigateOptions } from "../commands/investigate.js";
import { saveUserCredentials, saveUserSettings } from "../core/config.js";
import { ensureModel, keepFoundryLocalAlive, shutdownFoundryLocal } from "../core/foundryModel.js";
import { VERSION_LABEL } from "../version.js";
import { logger } from "../utils/logger.js";
import { clearScreen, renderLogo } from "./logo.js";
import { BackToMenu, isUserCancel, terminalPrompter, type Choice, type Prompter } from "./prompter.js";
import { collectStatus, modelSize, renderStatus, type Status } from "./status.js";

export type MenuChoice = "investigate" | "docs" | "ask" | "setup" | "connect" | "doctor" | "accelerate" | "exit";

/** Everything the menu does to the outside world, so tests can substitute fakes. */
export interface MenuDeps {
  ui: Prompter;
  status: () => Promise<Status>;
  /** Clears the screen and draws the logo and status panel. */
  draw: (status: Status) => void;
  actions: {
    investigate: (id: string, opts: InvestigateOptions) => Promise<void>;
    docs: () => Promise<void>;
    ask: (question: string) => Promise<void>;
    init: (opts: InitOptions) => Promise<void>;
    doctor: (opts: DoctorOptions) => Promise<void>;
    saveCredentials: (email: string, pat: string) => string;
    /** Remembers the user's yes/no about enabling the NPU/GPU. */
    setAccelerators: (enabled: boolean) => void;
    /** Downloads (if needed) and loads the model that will be used, keeping it warm for the actions that follow. */
    prepareModel: (alias?: string) => Promise<void>;
  };
  log: Pick<typeof logger, "ok" | "info" | "warn" | "error">;
}

/** Accepts "Contoso" as well as a pasted "https://dev.azure.com/Contoso/" URL. */
export function normalizeOrganization(value: string): string {
  const v = value.trim();
  const fromUrl = /dev\.azure\.com\/([^/\s]+)/i.exec(v) ?? /^https?:\/\/([^./\s]+)\.visualstudio\.com/i.exec(v);
  return fromUrl ? fromUrl[1] : v;
}

const required = (what: string) => (value: string) => (value.trim() ? true : `Please enter ${what}.`);

export function menuChoices(status: Status): Choice<MenuChoice>[] {
  const needsRepo = status.repoRoot ? false : "open TraceForge inside a git repository";
  return [
    { name: "Investigate a work item", value: "investigate", disabled: needsRepo, description: "Fetch a work item from Azure DevOps, search this repo for related code, and write a report" },
    { name: "Generate repository docs", value: "docs", disabled: needsRepo, description: "Write an onboarding overview from this repo's real files, manifests and history" },
    {
      name: "Ask about this code",
      value: "ask",
      disabled: status.projectRoot ? false : "open TraceForge inside a project folder",
      description: "Free-form question; the model can list, read and search files (and read git history in a git repository)",
    },
    { name: "Set up this repository", value: "setup", disabled: needsRepo, description: "Choose the Azure DevOps organization and project for this repo" },
    { name: status.credentials ? "Update Azure DevOps sign-in" : "Connect Azure DevOps", value: "connect", description: "Store your email and Personal Access Token for every repository (kept in your user folder)" },
    { name: "Check system health", value: "doctor", description: "Verify tools, on-device AI, and the Azure DevOps connection" },
    {
      name: "Enable NPU / GPU acceleration",
      value: "accelerate",
      description:
        status.npu === "available"
          ? "Recommended: an NPU was detected but isn't enabled yet. Downloads its runtime, then models run on the NPU automatically"
          : "Download and register accelerator runtimes so models run on the NPU or GPU",
    },
    { name: "Exit", value: "exit" },
  ];
}

async function setupFlow(deps: MenuDeps, status: Status): Promise<void> {
  const { ui, actions } = deps;
  const organization = normalizeOrganization(
    await ui.input("Azure DevOps organization (name or URL)", { default: status.config?.organization, validate: required("the organization") })
  );
  const project = (await ui.input("Azure DevOps project", { default: status.config?.project, validate: required("the project") })).trim();
  const docs = await ui.confirm("Generate repository documentation now?", !status.config);
  const vscode = await ui.confirm("Add VS Code tasks and a Copilot MCP registration?", false);
  await actions.init({ org: organization, project, skipDocs: !docs, vscode });
}

async function connectFlow(deps: MenuDeps, status: Status): Promise<void> {
  const { ui, actions, log } = deps;
  log.info("Create a Personal Access Token at https://dev.azure.com/<your-org>/_usersSettings/tokens");
  log.info("Scopes: Work Items — Read (Read & write if you want TraceForge to post comments), plus Wiki — Read and Code — Read so answers can use your team wiki.");
  const email = (
    await ui.input("Azure DevOps account email", {
      default: status.email,
      validate: (v) => (/^\S+@\S+$/.test(v.trim()) ? true : "Please enter the email address of your Azure DevOps account."),
    })
  ).trim();
  const pat = (await ui.password("Personal Access Token (hidden)")).trim();
  if (!pat) {
    log.warn("No token entered — nothing was saved.");
    return;
  }
  const path = actions.saveCredentials(email, pat);
  log.ok(`Saved to ${path} — plain text in your user folder, never inside a repository.`);
  if (await ui.confirm("Test the connection now?", true)) await actions.doctor({ checkAdo: true });
}

/** Makes sure the repo is configured and signed in, offering to fix whichever piece is missing. */
async function ensureAzureDevOpsReady(deps: MenuDeps, status: Status): Promise<boolean> {
  let current = status;
  if (!current.config) {
    if (!(await deps.ui.confirm("Azure DevOps isn't set up for this repository yet. Set it up now?", true))) return false;
    await setupFlow(deps, current);
    current = await deps.status();
    if (!current.config) return false;
  }
  if (!current.credentials) {
    if (!(await deps.ui.confirm("You're not signed in to Azure DevOps yet. Connect now?", true))) return false;
    await connectFlow(deps, current);
    current = await deps.status();
    if (!current.credentials) return false;
  }
  return true;
}

async function investigateFlow(deps: MenuDeps, status: Status): Promise<void> {
  if (!(await ensureAzureDevOpsReady(deps, status))) return;
  const id = (
    await deps.ui.input("Work item ID", {
      validate: (v) => (/^\d+$/.test(v.trim()) && Number(v) > 0 ? true : "Enter the numeric ID of the work item, e.g. 42."),
    })
  ).trim();
  const postComment = await deps.ui.confirm("After the report, offer to post it on the work item as a comment?", false);
  await deps.actions.investigate(id, { postComment });
}

async function runChoice(choice: Exclude<MenuChoice, "exit">, deps: MenuDeps, status: Status): Promise<void> {
  switch (choice) {
    case "investigate":
      return investigateFlow(deps, status);
    case "docs":
      return deps.actions.docs();
    case "ask": {
      const question = (await deps.ui.input("What would you like to know?", { validate: required("a question") })).trim();
      return deps.actions.ask(question);
    }
    case "setup":
      return setupFlow(deps, status);
    case "connect":
      return connectFlow(deps, status);
    case "doctor":
      return deps.actions.doctor({ checkAdo: true });
    case "accelerate":
      if (await deps.ui.confirm("This downloads accelerator runtimes (can be several hundred MB). Continue?", false)) {
        await deps.actions.doctor({ accelerate: true });
      }
      return;
  }
}

/**
 * First launch on a machine with an NPU that isn't enabled yet: ask once whether to enable it, and remember the
 * answer (accelerator registration only lasts for one process, so a "yes" is what makes it happen at every start).
 */
async function offerAcceleration(deps: MenuDeps): Promise<void> {
  try {
    const yes = await deps.ui.confirm(
      "An NPU was detected on this machine. Download its runtime once and use it automatically from now on? (a few hundred MB)",
      true
    );
    if (!yes) {
      deps.actions.setAccelerators(false);
      deps.log.info('OK — staying on the CPU. Choose "Enable NPU / GPU acceleration" any time to change this.');
    } else {
      await deps.actions.doctor({ accelerate: true });
    }
    await deps.ui.input("↵  Press Enter to continue");
  } catch (err) {
    if (err instanceof BackToMenu) return; // Esc: not now — ask again next time
    if (isUserCancel(err)) throw err;
    deps.log.error(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The model isn't on disk yet: offer to download and load it now, rather than making the user wait in the middle of
 * their first question. It also surfaces any problem loading it (e.g. an outdated NPU driver) up front.
 */
async function offerModelDownload(deps: MenuDeps, status: Status): Promise<void> {
  try {
    const yes = await deps.ui.confirm(
      `${status.model} isn't downloaded yet${modelSize(status)}. Download and load it now, so your first question is instant?`,
      true
    );
    if (!yes) return; // it will download on first use instead
    await deps.actions.prepareModel(status.config?.model);
    await deps.ui.input("↵  Press Enter to continue");
  } catch (err) {
    if (err instanceof BackToMenu) return; // Esc: not now
    if (isUserCancel(err)) throw err;
    deps.log.error(err instanceof Error ? err.message : String(err));
    await deps.ui.input("↵  Press Enter to continue");
  }
}

/** The menu loop. Returns when the user picks Exit or presses Ctrl+C. */
export async function runMenu(deps: MenuDeps): Promise<void> {
  let offered = false;
  let modelOffered = false;
  for (;;) {
    let status: Status;
    try {
      status = await deps.status();
      deps.draw(status);

      if (!offered && status.npu === "available" && status.acceleratorDecision === undefined) {
        offered = true;
        await offerAcceleration(deps);
        continue; // redraw with the new state
      }

      if (!modelOffered && status.modelCached === false) {
        modelOffered = true;
        await offerModelDownload(deps, status);
        continue;
      }

      const choice = await deps.ui.select("What would you like to do?", menuChoices(status));
      if (choice === "exit") return;

      try {
        await runChoice(choice, deps, status);
      } catch (err) {
        if (err instanceof BackToMenu) continue; // Esc mid-flow: straight back, nothing to read
        if (isUserCancel(err)) return;
        deps.log.error(err instanceof Error ? err.message : String(err));
      }
      await deps.ui.input("↵  Press Enter to return to the menu");
    } catch (err) {
      if (err instanceof BackToMenu) continue; // Esc at the "press Enter" pause
      if (isUserCancel(err)) return;
      throw err;
    }
  }
}

/** Starts the interactive TraceForge experience on the real terminal. */
export async function runInteractive(): Promise<void> {
  keepFoundryLocalAlive(true);
  let firstStatus = true;
  try {
    await runMenu({
      ui: terminalPrompter,
      status: async () => {
        const spinner = firstStatus && process.stdout.isTTY ? ora("Starting TraceForge…").start() : undefined;
        firstStatus = false;
        try {
          return await collectStatus();
        } finally {
          spinner?.stop();
        }
      },
      draw: (status) => {
        clearScreen();
        console.log(renderLogo({ columns: process.stdout.columns ?? 80, version: VERSION_LABEL }));
        console.log(renderStatus(status));
        console.log();
      },
      actions: {
        investigate: runInvestigate,
        docs: async () => void (await runDocs()),
        ask: (question) => runAsk(question),
        init: runInit,
        doctor: runDoctor,
        saveCredentials: (email, pat) => {
          const path = saveUserCredentials(email, pat);
          process.env.ADO_EMAIL = email;
          process.env.ADO_PAT = pat;
          return path;
        },
        setAccelerators: (enabled) => saveUserSettings({ accelerators: enabled }),
        prepareModel: async (alias) => void (await ensureModel(alias)),
      },
      log: logger,
    });
  } finally {
    keepFoundryLocalAlive(false);
    shutdownFoundryLocal();
  }
  console.log("\nSee you next time. ◆\n");
}
