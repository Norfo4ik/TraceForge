# TraceForge

**Trace work items to code — with AI that never leaves your machine.**

TraceForge is a terminal app that investigates Azure DevOps work items against your repository, answers questions about your code and your team's wiki, and writes onboarding docs — powered by **on-device AI** ([Microsoft Foundry Local](https://learn.microsoft.com/windows/ai/foundry-local/), running on the NPU of a Copilot+ PC when there is one) so no prompt, source code or wiki page is sent to a cloud AI service.

```
  █████ ████   ███   ████ █████ █████  ███  ████   ████ █████
    █   █   █ █   █ █     █     █     █   █ █   █ █     █
    █   ████  █████ █     ████  ████  █   █ ████  █  ██ ████
    █   █  █  █   █ █     █     █     █   █ █  █  █   █ █
    █   █   █ █   █  ████ █████ █      ███  █   █  ████ █████
```

## Install

One command, in PowerShell (Windows 10/11; Copilot+ PC recommended):

```powershell
irm https://raw.githubusercontent.com/Norfo4ik/TraceForge/master/install.ps1 | iex
```

It installs **Node.js** and **Git** with winget if they are missing, installs the latest TraceForge release, puts `traceforge` on your PATH, and offers to start it. The AI model and the NPU/GPU runtimes are not part of the install: TraceForge offers to download them on first start (with the size shown) so nothing large happens behind your back.

Options (run the script as a scriptblock to pass them):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Norfo4ik/TraceForge/master/install.ps1))) -NoLaunch -SkipGit
```

| Option | Effect |
|---|---|
| `-NoLaunch` | Don't offer to start TraceForge at the end (or set `TRACEFORGE_NO_LAUNCH=1`). |
| `-SkipGit` | Don't install Git if it's missing (plain-folder mode only, no commit history). |
| `-NoPathUpdate` | Don't add npm's global folder to your PATH. |
| `-Source <tgz-or-url>` | Install that tarball instead of the latest release (or set `TRACEFORGE_SOURCE`). |

Update later with `traceforge update`. Prefer to see the script first? It is [install.ps1](install.ps1) — about 150 lines.

### Building from source

```bash
npm install
npm run build
npm link            # installs the `traceforge` command from this checkout
traceforge          # opens the interactive menu
```

After pulling new changes, run `npm run build` again — `traceforge` runs the built `dist/`, so an old build keeps behaving like the old code (check with `traceforge --version`). `npm test` runs the unit tests; `npm run dev -- <command>` runs the CLI straight from source.

### Publishing a release (maintainers)

Bump `version` in package.json, commit, then tag and push `v<version>`. The **Release** workflow tests, packs `traceforge.tgz` and attaches it, with `install.ps1`, to a GitHub release — which is what the install command and `traceforge update` download.

## Using it

Run `traceforge` with no arguments in your project folder to get the menu: the screen clears, the logo and a status panel (repository, Azure DevOps sign-in, which device the AI will use) appear, and you pick with the arrow keys:

| Menu item | What it does |
|---|---|
| Investigate a work item | Fetches the work item from Azure DevOps, searches the repo for related code, and writes a report. Optionally offers to post it back as a comment (always asks first). |
| Generate repository docs | Writes an onboarding overview from the repo's real files, manifests and history. |
| Ask about this code | Free-form question; answers also draw on your team's **Azure DevOps Wiki** when it's set up (see below). The model can list, read and search files, and read git history when the folder is a git repository. Works in a plain project folder too (no `git init` needed) — it just has no history to look at. Outside any project it says so instead of guessing. |
| Set up this repository | Chooses the Azure DevOps organization and project (accepts a pasted `https://dev.azure.com/<org>` URL). |
| Connect Azure DevOps | Stores your email and Personal Access Token once, for every repository. |
| Check system health | Verifies tools, on-device AI and the Azure DevOps connection. |
| Enable NPU / GPU acceleration | Downloads and registers accelerator runtimes so models run on the NPU or GPU. |

*Ask* works in any folder that looks like a project. *Investigate*, *Generate docs* and *Set up* need a git repository. If something needed is missing (repo not set up, not signed in), the menu offers to fix it right there instead of stopping. **Esc** goes back to the menu from any prompt (nothing is saved when you back out); **Ctrl+C** exits.

`traceforge --version` prints the version and the exact commit it was built from, e.g. `0.1.0 (0bbc7c5)` — handy when checking which copy is installed.

If you renamed from the earlier prototype: run `npm uninstall -g local-devops-copilot` to drop the old `localdevops` command, and re-run *Set up this repository* in repos that used it (its settings folder is now `.traceforge/`).

## Requirements

- Node.js 20+ and git (the installer adds them if missing)
- An Azure DevOps organization and a [Personal Access Token](https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate) with **Work Items: Read**, **Wiki: Read** and **Code: Read** (the last two are for wiki search; Work Items: Read & write only if you want TraceForge to post comments)

### Credentials

Use **Connect Azure DevOps** in the menu, or create the file yourself. Either way they end up in `~/.traceforge/.env` (plain text, in your user folder, never in a repo), which every repo falls back to. A `.env` inside a repo takes priority (`Set up this repository` adds it to that repo's `.gitignore`). See `.env.example` for the format. Never commit a token.

## Scripting (non-interactive commands)

Everything the menu does is also a command, for scripts, CI and VS Code tasks. Given any arguments (or when not attached to a terminal) TraceForge behaves as a normal CLI:

| Command | What it does |
|---|---|
| `traceforge doctor [--accelerate] [--check-ado]` | Checks tools, on-device AI (which of NPU/GPU/CPU the model will use), and Azure DevOps setup. `--accelerate` downloads and registers NPU/GPU execution providers; `--check-ado` makes a real connection to verify credentials. Credentials are reported as set/missing, never printed. |
| `traceforge init --org <org> --project <project> [--vscode]` | Configures Azure DevOps for the repo (`.traceforge/config.json`), git-ignores local files, and generates first-run docs. `--vscode` also creates VS Code tasks and an MCP registration (existing files are never overwritten). |
| `traceforge docs` | (Re)generates `docs/GENERATED_OVERVIEW.md`. |
| `traceforge investigate <id> [--post-comment [--yes]]` | Writes a report to `.traceforge/investigations/<id>.md`. `--post-comment` previews it and asks before posting it to the work item as an AI-labelled comment; without a terminal it refuses unless `--yes` is given. |
| `traceforge ask "<question>"` | Free-form Q&A with the repo tools. Works without Azure DevOps configured. |
| `traceforge wiki "<query>"` | Shows which Azure DevOps wiki pages TraceForge would give the model for that query — no AI involved. The way to check what Ask/Investigate see in the wiki. |
| `traceforge update` | Reinstalls TraceForge from the latest release. |
| `traceforge mcp [--repo <path>]` | Serves the read-only repo tools as an MCP server over stdio, for any MCP client (VS Code / GitHub Copilot, Claude, …). |

Every generation ends with a line such as `Inference ran on-device on NPU (QNNExecutionProvider) in 41.3s — no prompt or code was sent to a cloud AI service.` Add `-v` to `ask`, `docs` or `investigate` for details.

### In VS Code

`traceforge init --vscode` adds *Terminal ▸ Run Task ▸ "TraceForge: …"* entries (investigate a work item — with or without posting the comment —, generate docs, doctor) and a `.vscode/mcp.json` that registers `traceforge mcp`, so Copilot agent mode can read and search the repo through the same tools.

## Azure DevOps Wiki

When a repository is set up for Azure DevOps and you're signed in, **Ask** and **Investigate** also look in the project's wiki: they search it for the question (or the work item's text), read the best-matching pages, and give the model the relevant parts — so answers about setup, deployment, conventions and troubleshooting come from your team's own runbooks, with the page path cited. The pages are read through the official Azure DevOps MCP server (read-only) and only ever reach the local model.

- **Token scope:** the Personal Access Token needs **Wiki: Read** (and **Code: Read** for full-text wiki search). Without it TraceForge says so in one line and carries on without the wiki. `traceforge doctor --check-ado` reports wiki access.
- **See what it finds:** `traceforge wiki "how do we deploy to staging"` prints the pages, no AI involved.
- **Fresh wikis:** full-text search can lag behind new pages; TraceForge falls back to matching page titles.
- **Turn it off:** set `"wiki": false` in `.traceforge/config.json`, or `TRACEFORGE_WIKI=off`.
- **Safety:** wiki text is treated as reference material, never as instructions, and the model has no Azure DevOps tools that could act on it.
- **Limits:** up to 3 pages per question, each cut to the part around your search words (about 4,000 characters), and further trimmed to fit the model's context window. If the wiki holds nothing relevant, the answer says so rather than guessing.
- **Speed:** the lookup adds a few seconds per question (it starts the Azure DevOps MCP server, searches, reads pages and closes it).

## How it works

- **Evidence first, model second.** For `investigate` and `docs` the CLI gathers the facts itself — the work item and comments through the official [`@azure-devops/mcp`](https://github.com/microsoft/azure-devops-mcp) server (read-only calls), related code via `git grep`, structure/manifests/history via git — and hands the local model a compact, real dataset to write from. Small models are far more faithful at summarizing supplied data than at choosing among dozens of tools, and this keeps Azure DevOps write tools out of the model's reach entirely; the only write is the explicit, confirmed `--post-comment`.
- **Tool-calling agent loop.** `ask` gives the model local repo tools (list/read/grep files, git log/diff) with recovery for malformed tool calls.
- **Guarded output.** Repetition loops, noise, leaked reasoning or a missing heading are retried once and otherwise rejected rather than saved.
- **MCP both ways.** TraceForge consumes the Azure DevOps MCP server and serves its own repo tools as one (`traceforge mcp`).

## Model

Defaults to `qwen3-4b` (tool-calling capable, ~2.8GB) on CPU/GPU; on a machine with an NPU, TraceForge picks the best model that has an NPU build instead (for example `phi-4-mini`) and says so. Override with `TRACEFORGE_MODEL=<alias>` (also honoured from a `.env`) or `traceforge init --model <alias>` — e.g. `qwen2.5-coder-7b` for stronger code understanding on a beefier machine.

### Settings

| Variable | Effect |
|---|---|
| `TRACEFORGE_MODEL=<alias>` | Use this model; it is never swapped for another. |
| `TRACEFORGE_DEVICE=cpu\|gpu\|npu` | Force a device (to compare speeds, for instance). |
| `TRACEFORGE_ACCELERATE=off` | Don't register the NPU/GPU runtimes at startup. |
| `TRACEFORGE_WIKI=off` | Don't consult the Azure DevOps wiki. |
| `TRACEFORGE_DEBUG=1` | Show the inference runtime's own output and what the model returned. |

These can also go in a `.env`. Per-user choices (accelerator opt-in, builds that failed to load, learned context windows) live in `~/.traceforge/settings.json`.

### Small context windows

NPU model builds often have a small context window — `phi-4-mini` on an Intel NPU holds about 4,200 tokens, far less than a large repository's file list. TraceForge sizes what it sends to the model's window: the repository overview, wiki pages, work item and tool results are trimmed to fit, and the answer space is reserved. When the catalog doesn't report a window, the first oversized request makes the runtime state it; TraceForge then retries once with a prompt sized to it (you may see one "retrying" line) and remembers the number for next time. On a big repository that means the model sees a trimmed overview and finds details with its tools — a larger-window model (`TRACEFORGE_MODEL=…`) sees more up front.

### Known limitations

- **Small-model quality.** These models can add small inaccuracies (a file path or CLI flag that doesn't exist) and generic filler in sections like "Known Gaps" or "Next Steps". Treat answers as a fast starting point and check the cited files. Two ways to raise quality: try a larger model (`TRACEFORGE_MODEL=qwen2.5-coder-7b`), or run on a Copilot+ PC where the NPU makes larger models practical. On a CPU-only machine an answer takes about a minute or more, so for a live demo pre-generate reports.
- **Git repositories only** for *Investigate*, *Generate docs* and *Set up*. *Ask* also works in plain folders.
- **Ask in a git repository sees tracked files.** Files not yet added to git are not listed; in a plain folder it lists everything that isn't dependencies or build output (it doesn't read `.gitignore`).
- **The wiki lookup needs the token scopes above** and a wiki with pages; a brand-new wiki may take a while to be searchable (title matching covers the gap).

## Running on the NPU

Foundry Local can run models on the NPU of a Copilot+ PC (Snapdragon X, Intel Core Ultra 200V, AMD Ryzen AI 300), but the vendor runtime (an *execution provider*) has to be downloaded and registered first. On the first launch of the menu on such a machine TraceForge asks once whether to enable it; you can also use the menu item **Enable NPU / GPU acceleration** or:

```bash
traceforge doctor --accelerate   # downloads the runtimes (cached) and saves your opt-in in ~/.traceforge/settings.json
traceforge doctor                # shows which device the model will use
```

Registration only lasts for one process, so once you've opted in TraceForge re-registers the runtimes automatically every time it starts (quick, since they're already downloaded); set `TRACEFORGE_ACCELERATE=off` to skip that. TraceForge then chooses the device first — NPU, then GPU, then CPU — and the best model with a build for it. Not every model has an NPU/GPU build, so if the usual default (`qwen3-4b`) has none on your machine, TraceForge picks the best model that does and says so (`auto-selected: …` in the status panel and in `doctor`, which also lists every model with an NPU/GPU build on your machine). A model you choose yourself (`TRACEFORGE_MODEL`, or `--model` in setup) is never swapped. If an accelerated model fails to load, it falls back to the CPU build. To compare devices for a demo, force one: `TRACEFORGE_DEVICE=cpu traceforge investigate 1` vs `TRACEFORGE_DEVICE=npu traceforge investigate 1` — the closing timing line shows the device and elapsed time.

### If the NPU build won't load

If a model's NPU build fails to load, TraceForge says why in plain English, tries the next device (GPU, then CPU) and remembers the failure so it doesn't download and fail the same build on every start. A common cause, seen on an Intel Core Ultra PC: *"the NPU driver on this PC is older than this model build needs"* (the model was compiled for NPU compiler API 8.2 but the installed driver supports 8.1). The fix is to **update the Intel NPU driver** (Windows Update → Advanced options → Optional updates, or your PC maker's / Intel's driver page), restart, then choose **Enable NPU / GPU acceleration**, which clears the remembered failures and tries again. `traceforge doctor` lists any builds it is currently skipping. Set `TRACEFORGE_DEBUG=1` to see the inference runtime's own detailed output, which is otherwise hidden.

If the chosen model isn't downloaded yet, the menu offers to download and load it at startup (with its size) so your first question isn't the one that waits.

**Status:** verified on an Intel Core Ultra Copilot+ PC (OpenVINO NPU and WebGPU, after updating the NPU driver): `phi-4-mini` runs on the NPU and answers a question in roughly a minute. Snapdragon X (QNN) and AMD Ryzen AI machines use the same selection logic but haven't been tried.

### Checking that it really runs on the device

- The closing line of every answer names the execution provider and elapsed time, and `traceforge doctor` shows which device the model will use.
- On a Copilot+ PC, Task Manager → Performance → NPU shows load while a question is being answered.
- The model runs inside a local Foundry Local service on your machine; the only network traffic TraceForge makes is to Azure DevOps (through its MCP server) and, the first time, model and runtime downloads.
