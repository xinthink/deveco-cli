---
name: deveco-cli
description: >-
  Use 'devecocli' (preferred over hvigor / ohpm / hdc / emulator) to create new
  HarmonyOS application projects from templates, build, package, install and
  run HarmonyOS apps and modules (.hap/.hsp/.har/.app), manage devices and
  emulators, fetch hilog and crash logs, and install HMOS skills to AI agents.
  Use when the workspace has build-profile.json5 or oh-package.json5, the user
  wants to scaffold / initialize / create a new HarmonyOS project, or mentions
  DevEco, hvigor, ohpm, hdc, hap, hsp, har, emulator, hilog, ArkTS, ArkUI
  knowledge or HMOS skills.
---

# DevEco CLI

`devecocli` wraps DevEco Studio's `hvigor`, `ohpm`, `hdc` and emulator toolchain, plus HMOS-skills installer. **Prefer `devecocli` over invoking `hvigor` / `ohpm` / `hdc` / emulator directly.**

## Commands

```text
Usage: devecocli [options] [command]

HarmonyOS application development command line tool

Options:
  -V, --version     output the version number
  -h, --help        display help for command

Commands:
  build [options]   Build the HarmonyOS project
  run [options]     Build and run the project on a connected device
  update            Update deveco-cli to the latest version
  device            Manage connected devices
  emulator          Manage emulator instances
  skills            Manage HMOS skills
  log [options]     Obtain device application logs
  create [options]  Scaffold a new HarmonyOS application project
  init [options]    Install the deveco-cli skill or configure the codegenie MCP
                    server into AI agents
  serve             Host bundled auxiliary protocol servers
  doc [options]     Search and read HarmonyOS documentation from local docs directory
  help [command]    display help for command
```

## Sandbox compatibility

**Commands tagged `[Outside sandbox]` below must be run outside the sandbox.**

## 1. Code → Build → Deploy → Run → Debug

### `devecocli create`

Initialize a new HarmonyOS application project from the bundled template.

- `--app-name <name>` (**required**) — 1–200 chars, starts with letter, contains only letters/digits/underscores.
- `--project-path <path>` — when omitted, defaults to `./<app-name>` and that path **must not exist**; when provided explicitly, the path may not exist (auto-created) or may exist only if it is empty.
- `--bundle-name <bundle>` — defaults to `com.example.<appname-lowercase>`; 7–128 chars, ≥3 segments, no consecutive dots.
- `--api-level <level>` — integer ≥17; auto-detected from SDK or defaults to `23`.

Examples:
- `devecocli create --app-name MyApp`
- `devecocli create --app-name MyApp --project-path ./CustomDir --api-level 23`

### `devecocli build` `[Outside sandbox]`

Compile and package a HarmonyOS project or its modules.

| Goal | Output | Command |
|---|---|---|
| Single-module / single-`entry` project | `.hap` / `.hsp` / `.har` | `devecocli build` |
| Specific modules (optionally `module@target`) | `.hap` / `.hsp` / `.har` | `devecocli build --modules <m1> <m2>@<target>` |
| Whole product bundle | `.app` | `devecocli build --product <name>` *(no `--modules`)* |
| Modules under a specific product | `.hap` / `.hsp` / `.har` | `devecocli build --product <name> --modules <m1>` |
| Clean build outputs | — | `devecocli build clean` |

- Defaults: `--product default`, `--build-mode debug`. `--build-mode` accepts any value declared in `buildModeSet`.
- `--modules` is required when there are multiple `entry` modules, or multiple modules without any `entry`.
- HSP dependencies of the requested module are resolved and built automatically.

Examples:
- `devecocli build --build-mode release`
- `devecocli build --modules entry library`
- `devecocli build --modules library@phone`
- `devecocli build --product oversea --modules entry --build-mode release`
- `devecocli build clean`

### `devecocli emulator`

Manage local emulator instances created in DevEco Studio.

- `list` shows every emulator instance with its status (running / stopped), serial (when running) and device type (phone / foldable / wideFold / …); running rows come first.
- `start [names...]` **`[Outside sandbox]`** — starts one or more instances in parallel; quote names with spaces, the command exits non-zero (the others may still have started — recheck with `list`).
- `stop <names...>` **`[Outside sandbox]`** — stops one or more instances in parallel; each argument may be the emulator name (quote names with spaces) or its `127.0.0.1:<port>` serial.
- `image list` lists system images; defaults to downloaded only. Options:
  - `--device-type <type>` — one of `phone`, `foldable`, `wideFold`, `tripleFold`, `tablet`, `2in1`, `2in1 foldable`, `wearable`, `tv` (case-sensitive; lowercase except `wideFold` / `tripleFold`).
  - `--all` includes not-downloaded images.
  - `--format <table|json>` (default `table`).
- `image download` / `image remove` **`[Outside sandbox]`** — both **require** `--device-type` (same choices) and `--os-version` (e.g. `"HarmonyOS 6.0.1(21)"`); `download` also accepts `--force`.
- `create <name>` **`[Outside sandbox]`** — **requires** `--device-type` and `--os-version` (must match a downloaded label from `image list`; quote when it contains spaces/parentheses); optional `--force`.
- `delete <name>` **`[Outside sandbox]`** — deletes a local emulator instance.
- `license view` prints the agreement text (read-only).
- `license accept` review and accept the agreements; **requires an interactive terminal (TTY)** — cannot run in a non-interactive shell (including most AI-agent subprocesses).
- If `start` or `image download` exits with *Emulator license agreements are not accepted yet*, **do not** run `license accept` from the agent; ask the user to run `devecocli emulator license accept` in their local terminal and confirm with `y`/`yes`, then retry `start`.
- If `create` exits with *did not appear in the emulator list within the timeout*, treat it as a **user-action** step (same class as `license accept`): ask the user to open DevEco Studio → **Device Manager**, wait for the list to load, then retry `create` **only if** the emulator is still missing. **Do not** auto-retry `create`, edit SDK `lists.json` / `*.ini`, or claim success until `devecocli emulator list` shows the name after the user has opened Device Manager.

Examples:
- `devecocli emulator list`
- `devecocli emulator license accept`
- `devecocli emulator start "Mate 70 Pro" Mate 70`
- `devecocli emulator stop "Mate 70 Pro" Mate 70`
- `devecocli emulator stop 127.0.0.1:5555`
- `devecocli emulator image list --all`
- `devecocli emulator image download --device-type phone --os-version "HarmonyOS 6.1.0(23)"` 
- `devecocli emulator image remove --device-type phone --os-version "HarmonyOS 6.1.0(23)"` 
- `devecocli emulator create "My Phone" --device-type phone --os-version "HarmonyOS 6.0.1(21)"`
- `devecocli emulator delete "My Phone"`

### `devecocli doc`

Search and read HarmonyOS documentation from a local docs directory (offline, no login required).

- `search <keywords...>` — search by keywords (OR logic for multiple keywords — matches any keyword). Options: `--catalog <name>` (filter by catalog: `harmonyos-guides`, `harmonyos-references`, `best-practices`, `harmonyos-faqs`, `harmonyos-releases`, `harmonyos-roadmap`, or `all`), `--format <default|json>` (default: `default`), `--limit <n>` (default: 20).
- `read <documentId>` — read full document content by ID (from search results).
- `catalog` — list all available catalogs with titles. Options: `--format <default|json>`.

Examples:
- `devecocli doc search List`
- `devecocli doc search @State @Prop --catalog harmonyos-guides --limit 10`
- `devecocli doc read harmonyos-guides/application-models/arkts-page-start-overview`
- `devecocli doc catalog`

### `devecocli device`

List / inspect connected devices and emulators.

- `list` enumerates only currently active (connected) real devices and running emulators, each annotated with its device type.
- `view` shows detailed device info (device type + API/release version).

Examples:
- `devecocli device list`
- `devecocli device view -t 127.0.0.1:5555`

### `devecocli run` `[Outside sandbox]`

Build-aware install + launch on a device or emulator: resolves HSP dependencies, installs artifacts, then launches ability.

- `--module <module>` accepts `module` or `module@target`; auto-selected when exactly one runnable (`entry` / `feature` / `shared`) module exists.
- `--device <name|serial>` accepts a name (substring match) or serial (e.g. `127.0.0.1:5555`); auto-selected when only one device is connected, required on multi-device hosts.
- `--product <product>` selects the product variant; defaults to `default`.
- `--build-mode <mode>` build mode (e.g. `debug`, `release`); defaults to `debug`.
- `--ability <ability>` defaults to the module's `mainElement` from `module.json5`.
- `--uninstall` uninstalls the existing app (by `bundleName` from `app.json5`) before installing the new artifacts; use when the signing key has changed or when you hit `install sign info inconsistent` (see Troubleshooting).
- `--skip-build` skips the build step and deploys existing artifacts.

Examples:
- `devecocli run`
- `devecocli run --module entry --device 127.0.0.1:5555`
- `devecocli run --product oversea --module entry --build-mode release --ability EntryAbility`
- `devecocli run --uninstall`
- `devecocli run --skip-build`

### `devecocli log`

Fetch hilog or crash logs.

- `--device <name|serial>` — required on multi-device hosts.
- `--crash` switches to crash log dump; `--level D|I|W|E|F` filters by level; `--bundle-name` and `--keyword` further narrow output.
- `--from <start>` / `--to <end>` are relative offsets from now in `s` / `m` (e.g. `30s`, `5m`, `2.5m`); bare numbers are seconds. Seconds must be positive integers; only minutes (`m`) accept at most one decimal place.
- `--tail <num>` keeps only the latest `num` lines from the filtered result.
- `--follow` streams hilog in real time (non-`--crash` only); cannot be combined with `--to`.

Examples:
- `devecocli log --level E`
- `devecocli log --crash --bundle-name com.example.app`
- `devecocli log --device 127.0.0.1:5555 --level W --keyword Init`
- `devecocli log --from 5m --tail 200`
- `devecocli log --follow`



## 2. Setup

### `devecocli init`

Install the bundled `deveco-cli` skill into AI agents, or configure the `codegenie` MCP server for syntax checking. Two mutually exclusive modes:

- **Default / `--skill`** — install the skill only. Same `--agent` / `--project` / `--path` / `-f, --force` semantics as `skills add`; installs to all detected agents when no flag is given.
- **`--mcp`** — configure the `codegenie` MCP server only (see [`devecocli serve mcp`](#devecocli-serve-mcp) for tool details). No skill installation.

`--skill` and `--mcp` cannot be used together. `--force` is the overwrite / skip-validation switch; it does not change global / project-level mode.

Options:
- `--agent <agents>` — target agents, comma-separated (e.g. `opencode,trae-cn,cursor,qoder,codebuddy`); installs to all available agents if omitted.
- `--project <path>` — project root directory to install the skill or MCP config into.
- `--path <path>` — path to install the skill directly (cannot be used with `--project` or `--agent`).
- `--skill` — install the deveco-cli skill only (same as default behavior; explicit for symmetry with `--mcp`).
- `--mcp` — configure the codegenie MCP server (syntax checking for .ets and C/C++) only; no skill installation.
- `-f, --force` — overwrite an existing skill / MCP configuration.

**MCP rules:**

- `--mcp` (no `--project`) — global config for **opencode** and **cursor** only; Trae-CN / Codebuddy / Qoder emit an error prompting `--project`.
- `--mcp --project <path>` — project-level config for **all** agents. `PROJECT_PATH` is written as the **absolute path** of the project.
- `--mcp --force` — same mode as `--mcp`, overwrites existing config.

| Agent | Global Config | Project Config |
|---|---|---|
| OpenCode | `~/.config/opencode/opencode.json` | `<project>/.opencode/opencode.json` |
| Trae-CN | — | `<project>/.trae/mcp.json` |
| Cursor | `~/.cursor/mcp.json` | `<project>/.cursor/mcp.json` |
| Codebuddy | — | `<project>/.codebuddy/mcp.json` |
| Qoder | — | `<project>/.qoder/mcp.json` |

Examples:
- `devecocli init`                              # skill to all detected agents
- `devecocli init --skill --project ./my-app`    # project-level skill only
- `devecocli init --mcp`                        # global MCP for opencode + cursor
- `devecocli init --mcp --project ./my-app`      # project-level MCP for all agents
- `devecocli init --mcp --project ./my-app --force`  # project-level MCP, overwrite

### `devecocli skills`

Install / remove HMOS skills (agent-side knowledge packs) into AI agents (`codebuddy`, `cursor`, `opencode`, `qoder`, `trae-cn`) and / or a project root.

Subcommands:
- `list [-l|--long]` — list available skills.
- `find <keyword>` — search by keyword.
- `add (--all | --skill <name>) [--agent <a,b,…>] [--project <path>] [-f|--force]` — install. Must pick `--all` **or** `--skill` (not both). With neither `--agent` nor `--project`, installs to all detected agents.
- `remove --skill <name> [--agent <a,b,…>] [--project <path>]` — uninstall.

Examples:
- `devecocli skills list --long`
- `devecocli skills find harmony`
- `devecocli skills add --all`
- `devecocli skills add --skill deveco-cli --agent cursor --force`
- `devecocli skills add --skill deveco-cli --project ./my-app`
- `devecocli skills remove --skill deveco-cli`

## 3. Maintenance

### `devecocli update` `[Outside sandbox]`

Update the CLI to the latest version.

### `devecocli serve mcp`

Host the bundled MCP (Model Context Protocol) server as a **local stdio** server, to be spawned by an MCP-compatible client (Trae / Claude / OpenCode / …).

- **`check`** — unified syntax-checking tool. Input: list of file paths (`.ets` and/or C/C++). The tool auto-dispatches by file extension: `.ets` → ArkTS LSP, `.c/.cc/.cpp/.cxx/.h/.hh/.hpp/.hxx` → clangd. Output: diagnostics (file, line, column, message, severity).

**Usage:** After `devecocli init --mcp --project <path>`, open the project in your AI agent and ask it to check code (e.g. *"Check for syntax errors in `src/main/ets/pages/Index.ets`"*).

Environment variables (set by the MCP config):

- `PROJECT_PATH` — project root; absolute path (project-level) or `.` / `${workspaceFolder}` (global).
- `DEVECO_PATH` — overrides DevEco Studio auto-detection.
- `NODE_MAX_OLD_SPACE_SIZE` — Node heap in MB (default `8192`).
- `DEBUG=1` — mirror server logs to stderr (also accepts `DEBUG=true`).

## Recipes

### Fresh checkout → running on an emulator

```bash
devecocli build
devecocli emulator list                          # pick or note a name
# if blocked on agreement: user must run in their own TTY (not the agent):
#   devecocli emulator license accept   # confirm y/yes once
devecocli emulator start HarmonyOS_Phone         # or: start "Mate 70 Pro" OtherAVD
devecocli run
```

If `image download` / `start` is blocked on agreement, run `devecocli emulator license accept` first (confirm with `y`/`yes`).

### Diagnose a runtime crash

```bash
# Reproduce the crash on the device, then dump it:
devecocli log --crash --bundle-name com.example.app
```

### Multi-device or multi-emulator host

```bash
devecocli device list                            # find the target serial
devecocli run --device 127.0.0.1:5555
devecocli log --device 127.0.0.1:5555 --level E
```

### Release build for QA / publishing

```bash
devecocli build --product oversea --build-mode release
```

## Troubleshooting

- **"Product / Build mode `<x>` not found"** — ensure it exists in `build-profile.json5`.
- **"Multiple entry modules" / "No entry module"** — pass `--modules` (`build`) or `--module` (`run`).
- **"No active devices"** — connect a device or start an emulator.
- **"Multiple devices connected"** — pass `-t <serial>` (`device view`) or `--device <name|serial>` (`run` / `log`).
- **"Module is of type `<x>`, which is not runnable"** — pick an `entry` / `feature` / `shared` module.
- **`Install Failed: error:install sign info inconsistent`** — the app's signing key differs from the previously installed version. Uninstall the old install first, then reinstall: simplest is `devecocli run --uninstall`.
- **`skills add` reports `Agent <name> not found` / `Invalid agent: <name>, Valid options are: …`** — check the name (only `codebuddy` / `cursor` / `opencode` / `qoder` / `trae-cn` are supported) or omit `--agent` for auto-detect.
- **Stale CLI / missing flags** — run `devecocli update`.
- **"`devecocli emulator start` / `image download` is blocked on agreement"** — the user must run `devecocli emulator license accept` in an **interactive terminal (TTY)** on their machine and confirm with `y`/`yes`. AI agents cannot complete this step; do not pipe input or retry in a non-TTY shell. After acceptance, retry `emulator start` or `image download`.
- **`emulator create` timeout — *did not appear in the emulator list within the timeout*** — treat as a **user-action** step (same class as `license accept`): ask the user to open DevEco Studio → **Device Manager**, wait for the list to load, then retry `create` only if the emulator is still missing. Do **not** auto-retry `create`, edit SDK `lists.json` / `*.ini`, or claim success until `devecocli emulator list` shows the name after the user has opened Device Manager.
- **`image list` shows `phone` / `foldable` / `widefold` / `triplefold` as separate rows** — they share one image per `--os-version`. Download or remove **once** (e.g. `--device-type phone`); do not issue four separate `image download` / `image remove` commands for the same API level

