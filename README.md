# TraceForge

**Trace work items to code — with AI that never leaves your machine.**

TraceForge is a terminal app that investigates Azure DevOps work items against your repository and writes onboarding docs for it, powered by **on-device AI** ([Microsoft Foundry Local](https://learn.microsoft.com/windows/ai/foundry-local/)) so no prompt or source code is sent to a cloud AI service.

```
  █████ ████   ███   ████ █████ █████  ███  ████   ████ █████
    █   █   █ █   █ █     █     █     █   █ █   █ █     █
    █   ████  █████ █     ████  ████  █   █ ████  █  ██ ████
    █   █  █  █   █ █     █     █     █   █ █  █  █   █ █
    █   █   █ █   █  ████ █████ █      ███  █   █  ████ █████
```

## Quick start

```bash
npm install
npm run build
npm link            # installs the `traceforge` command
traceforge          # opens the interactive menu
```

Run `traceforge` with no arguments in a git repository to get the menu: the screen clears, the logo and a status panel (repository, Azure DevOps sign-in, which device the AI will use) appear, and you pick with the arrow keys:

| Menu item | What it does |
|---|---|
| Investigate a work item | Fetches the work item from Azure DevOps, searches the repo for related code, and writes a report. Optionally offers to post it back as a comment (always asks first). |
| Generate repository docs | Writes an onboarding overview from the repo's real files, manifests and history. |
| Ask about this code | Free-form question; the model can list, read and search files and read git history. |
| Set up this repository | Chooses the Azure DevOps organization and project (accepts a pasted `https://dev.azure.com/<org>` URL). |
| Connect Azure DevOps | Stores your email and Personal Access Token once, for every repository. |
| Check system health | Verifies tools, on-device AI and the Azure DevOps connection. |
| Enable NPU / GPU acceleration | Downloads and registers accelerator runtimes so models run on the NPU or GPU. |

If something needed is missing (repo not set up, not signed in), the menu offers to fix it right there instead of stopping. **Esc** goes back to the menu from any prompt (nothing is saved when you back out); **Ctrl+C** exits.

If you renamed from the earlier prototype: run `npm uninstall -g local-devops-copilot` to drop the old `localdevops` command, and re-run *Set up this repository* in repos that used it (its settings folder is now `.traceforge/`).

## Requirements

- Node.js 20+
- git
- An Azure DevOps organization and a [Personal Access Token](https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate) (Work Items: Read; Read & write only if you want TraceForge to post comments)

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
| `traceforge mcp [--repo <path>]` | Serves the read-only repo tools as an MCP server over stdio, for any MCP client (VS Code / GitHub Copilot, Claude, …). |

Every generation ends with a line such as `Inference ran on-device on NPU (QNNExecutionProvider) in 41.3s — no prompt or code was sent to a cloud AI service.` Add `-v` to `ask`, `docs` or `investigate` for details.

### In VS Code

`traceforge init --vscode` adds *Terminal ▸ Run Task ▸ "TraceForge: …"* entries (investigate a work item — with or without posting the comment —, generate docs, doctor) and a `.vscode/mcp.json` that registers `traceforge mcp`, so Copilot agent mode can read and search the repo through the same tools.

## How it works

- **Evidence first, model second.** For `investigate` and `docs` the CLI gathers the facts itself — the work item and comments through the official [`@azure-devops/mcp`](https://github.com/microsoft/azure-devops-mcp) server (read-only calls), related code via `git grep`, structure/manifests/history via git — and hands the local model a compact, real dataset to write from. Small models are far more faithful at summarizing supplied data than at choosing among dozens of tools, and this keeps Azure DevOps write tools out of the model's reach entirely; the only write is the explicit, confirmed `--post-comment`.
- **Tool-calling agent loop.** `ask` gives the model local repo tools (list/read/grep files, git log/diff) with recovery for malformed tool calls.
- **Guarded output.** Repetition loops, noise, leaked reasoning or a missing heading are retried once and otherwise rejected rather than saved.
- **MCP both ways.** TraceForge consumes the Azure DevOps MCP server and serves its own repo tools as one (`traceforge mcp`).

## Model

Defaults to `qwen3-4b` (tool-calling capable, ~2.8GB). Override with `TRACEFORGE_MODEL=<alias>` (also honoured from a `.env`) or `traceforge init --model <alias>` — e.g. `qwen2.5-coder-7b` for stronger code understanding on a beefier machine.

### Known limitation: report quality at this model size

`qwen3-4b` can still add small inaccuracies (e.g. a CLI flag that doesn't exist) and generic filler in sections like "Known Gaps"/"Next Steps". This is a small-model ceiling, not an architecture bug. Two ways to raise quality: try a larger model (`TRACEFORGE_MODEL=qwen2.5-coder-7b traceforge docs`), or run on Copilot+ PC hardware, where the NPU makes larger models practical. On a CPU-only machine a report takes about a minute or more, so for a live demo pre-generate them.

## Running on the NPU

Foundry Local can run models on the NPU of a Copilot+ PC (Snapdragon X, Intel Core Ultra 200V, AMD Ryzen AI 300), but the vendor runtime (an *execution provider*) has to be registered first — menu item **Enable NPU / GPU acceleration**, or:

```bash
traceforge doctor --accelerate   # one-time: downloads and registers the providers this machine supports
traceforge doctor                # shows which device the model will use
```

After that, model loading prefers an NPU variant, then GPU, then CPU. To compare devices for a demo, force one: `TRACEFORGE_DEVICE=cpu traceforge investigate 1` vs `TRACEFORGE_DEVICE=npu traceforge investigate 1` — the closing timing line shows the device and elapsed time.

**Status:** the selection logic is unit-tested, but it has only been run on a CPU-only machine, where Foundry Local offers CPU variants only. NPU execution itself is untested until run on real Copilot+ hardware.
