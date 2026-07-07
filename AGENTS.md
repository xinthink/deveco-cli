# Agents.md

Guidance for AI coding assistants working in this repo.

## Project Overview

**deveco-cli** wraps the DevEco Studio toolchain (`ohpm`, `hvigor`, `hdc`, `emulator`, `hilog`, bundled `node` + JBR + SDK) plus the HarmonyOS skills installer, and a project-scaffolding template engine — all behind a single `devecocli` binary, with no need to set `PATH` / `DEVECO_SDK_HOME` / `JAVA_HOME`.

Capabilities: scaffold a new application project from the bundled template (`create`), build & package (`.hap` / `.hsp` / `.har` / `.app`), manage devices and emulators, install + launch (`run`), fetch `hilog` / crash logs, install / remove HarmonyOS skills for AI agents (Claude, Cursor, Gemini, OpenCode, …), and self-update.

Distribution: a single ESM bundle (`dist/cli.js`), exposed as the `devecocli` bin.

## Commonly Used Commands

```bash
npm run build      # tsup → dist/cli.js
npm run dev        # tsx watch mode
npm start          # tsx (one-shot, no build)
npm run lint       # eslint
npm run lint:fix   # eslint --fix
npm run format     # prettier --write
npm run license    # regenerate THIRD-PARTY-LICENSES
```

`prepublishOnly` runs `lint → license → build`.

## Architecture

### Directory Structure

```text
src/
├── cli.ts                    # Entry point; registers all commands with Commander
├── commands/                 # One file per CLI subcommand
│   ├── create.ts             # Scaffold a new project from templates/application
│   ├── build.ts   run.ts   update.ts
│   ├── device.ts  emulator.ts  log.ts
│   ├── skills.ts  init.ts
│   ├── serve.ts              # MCP server subcommand (serve mcp)
│   └── doc.ts                # Local HarmonyOS docs search/read/catalog (CLI command: `docs`)
├── skills/                   # HarmonyOS skills marketplace client (api + installer + agents)
│   ├── api.ts                       # HarmonyOS skills HTTP client + installed-agent discovery
│   ├── installer.ts                 # Download / extract / remove skill packages
│   ├── agents.ts                    # parseAgentList / getAllExistingAgents / summarizeOperationResults
│   └── mcp-installer.ts             # installMcpConfigToAgentGlobal / installMcpConfigToAgentProject / removeMcpConfigFromAgentGlobal / removeMcpConfigFromAgentProject
├── service/                  # Domain helpers
│   ├── device-manager.ts            # Connected-device discovery + name / device-type lookup
│   ├── emulator-types.ts            # `EmulatorInfo` + `normalizeListNameKey`
│   ├── emulator-list-parse.ts       # Parses `emulator -list -details` (JSON / text)
│   ├── emulator-start-strategies.ts # Builds `-start` / `-hvd` argv candidates + retries
│   ├── emulator-manager.ts          # list/start/stop + image + create/delete virtual device
│   ├── local-doc-service.ts         # Local HarmonyOS docs search + read (SQLite FTS5 + zip read)
│   ├── doc-initializer.ts           # postinstall: install index.zip or fallback local build
│   ├── doc-index/                   # SQLite FTS5 index, jieba tokenizer, docs.zip reader, search
│   └── doc-portal-types.ts          # CatalogName / CATALOG_NAMES / CATALOG_TITLES
├── utils/
│   ├── project.ts                  # Project discovery + JSON5 build-profile parsing
│   ├── tool-provider.ts            # Locate DevEco Studio + resolve toolchain paths
│   ├── template-provider.ts        # Copy templates/application + render API-level fields
│   ├── ohpm-adapter.ts   hvigor-adapter.ts
│   ├── hdc-adapter.ts    hilog-adapter.ts    hdc-param.ts
│   ├── emulator-spawn.ts           # Detached Emulator.exe spawn (parameterized argv)
│   ├── emulator-hdc-targets.ts     # `hdc list targets` filter for emulator serials
│   ├── emulator-image-list-parse.ts # Parses `emulator -imageList` JSON for downloaded osVersions
│   ├── emulator-license.ts         # Emulator SDK license agreement helpers
│   ├── build-lock.ts               # Per-project file lock to serialise builds
│   ├── common-utils.ts             # Shared validators (bundle / level / crash / duration / tail)
│   ├── spinner-helper.ts           # Stateful ora wrapper (start / stop / succeed / fail)
│   ├── ora-fail.ts                 # `exitWithListCommandError` helper
│   ├── text-table.ts               # Fixed-width table renderer used by `list` commands
│   ├── http-client.ts  cmd.ts  config.ts
│   └── logger.ts                   # debugLog (gated by DEVECO_CLI_DEBUG)
├── config/                   # constants (AGENT_SKILLS_CONFIG, AGENT_MCP_CONFIG), network, skills
│   ├── constants.ts                  # Re-exports from network, skills, and mcp modules
│   ├── mcp.ts                        # AgentMcpConfig / AGENT_MCP_CONFIG / buildMcpConfigForAgent / buildOpenCodeMcpConfig / buildMcpServerConfig
│   ├── network.ts                    # Network-related constants
│   └── skills.ts                     # Skills API constants and agent skills config paths
├── data/                     # Bundled data files
│   └── emulator-privacy-bundled.ts    # Bundled emulator privacy agreement data
└── types/                    # Shared type defs (SkillOperationResult, InitOptions with mcp/skill flags, McpConfigResult, HttpRequestConfig, HttpResponse)

mcp/src-server/               # Bundled MCP server (ArkTS/Cpp syntax checking via LSP)
├── index.ts                  # Exports createMcpServer, ArktsCheckTool, CppCheckTool
├── server.ts                 # DevecoCliMcpServer — stdio MCP server orchestrator
├── router.ts                 # ToolRouter — registers + dispatches MCP tools
├── tools/arkts-check.ts      # ArkTS syntax check via DevEco LSP
├── tools/cpp-check.ts        # C/C++ syntax check via clangd
├── lsp/                      # LSP client + ArkTS proxy (completion, diagnostics, symbols)
│   ├── ArktsLspManager.ts    # Lifecycle manager for ArkTS LSP process
│   ├── LspServerProxy.ts     # LSP protocol proxy
│   ├── core/                 # LSP client, callbacks, diagnostics, protocol handling
│   ├── model/                # LSP type models (Completion, Symbol, Capabilities, etc.)
│   ├── parse/                # JSON5 config parsers (build-profile, module, oh-package)
│   ├── sync/                 # ohpm install + build project orchestration
│   ├── watcher/              # ConfigFileWatcher + DependencyMapWatcher
│   ├── common/               # Shared utilities (CallbackRegistry, typeGuards)
│   ├── constant.ts           # LSP-related constants
│   ├── types.ts              # LSP type definitions
│   ├── utils.ts              # LSP utility helpers
│   ├── logger.ts             # LSP logger
│   └── lspTypeGuards.ts      # LSP type guard functions
└── utils/                    # MCP logger, constants, common helpers

templates/application/        # Project scaffold copied by `devecocli create`
```

### Key Components

- **`cli.ts`** — Commander entry; bootstraps `global-agent` to honour HTTP_PROXY env vars, registers 11 subcommands. `--version` is read from `process.env.npm_package_version` (injected by tsup). Also normalizes `devecocli <command> help` to `devecocli <command> --help` for leaf commands. Calls `ToolProvider.checkVersion()` on startup unless `DEVECO_CLI_SKIP_VERSION_CHECK=1`.
- **`commands/create.ts`** — Scaffolds a new application project. Requires `--app-name` (1–200 chars, letter-start, letters/digits/underscores only). `--project-path` defaults to `./<app-name>` (the auto path must not exist; an explicit `--project-path` may point at an existing directory only if it is empty). Path normalization: backslashes → forward slashes (Windows); consecutive slashes reduced to single. Deep paths auto-created with `mkdir -p` semantics; the closest existing parent must be writable. Validates `--bundle-name` (7–128 chars, ≥3 dot-separated segments, no consecutive dots). `--api-level` validated to ≥17 (max determined by SDK); auto-detected from SDK or defaults to `23`. Delegates file copy + config rendering to `utils/template-provider.ts`.
- **`commands/build.ts`** — Default action: pipeline `ohpm install --all → hvigor --sync → hvigor assemble*`. Auto-detects the entry module, resolves transitive HSP deps, and propagates `@target` suffixes. With `--product <name>` only, builds the whole-product `.app`; with `--modules <names…>`, builds specific modules; otherwise builds per-module `.hap` / `.hsp` / `.har`. Subcommand `build clean` runs `hvigor clean` then `hvigor --stop-daemon` to remove build outputs and stop the daemon.
- **`commands/run.ts`** — Auto-selects the runnable module (`entry`/`feature`/`shared`) and the device (name substring or exact serial), then installs HSP deps + the main `.hap` via `HdcAdapter.installApp` (which `hdc file send`s the artifacts to a temp dir and runs `hdc shell bm install -p`), and launches the ability (defaults to `EntryAbility` or the first ability from `module.json5`). Supports `--build-mode` (defaults to `debug`), `--skip-build` to deploy existing artifacts without rebuilding, `--ability <name>` to specify the ability, and `--uninstall` to uninstall the existing app before installation.
- **`commands/device.ts`** — Subcommands: `list` (currently active real devices and running emulators, each annotated with its device type), `view` (detailed info). Multi-device hosts must pass `-t <serial>` to `view`. Use `devecocli emulator list` to see installed-but-stopped emulators.
- **`commands/emulator.ts`** — CLI for local emulator `list` / `start` / `stop` / `create` / `delete` plus system-image helpers under `image`: `download` / `remove` / `list`, and license helpers under `license`: `view` / `accept`. `list` shows every instance with its status, serial and device type (running rows surfaced first). `image download` / `image remove` / `create` all require `--device-type` (lowercase only, one of `phone`, `foldable`, `widefold`, `triplefold`, `tablet`, `2in1`, `2in1 foldable`, `wearable`, `tv`) and `--os-version`; `image list` accepts `--device-type`, `--all` (downloaded + not downloaded), and `--format table|json`.
- **`service/emulator-manager.ts`** — `EmulatorManager` orchestrates list/start/stop + system-image install/uninstall/list + create/delete local virtual devices. List parsing: `service/emulator-list-parse.ts`; start strategies: `service/emulator-start-strategies.ts`; detached spawn: `utils/emulator-spawn.ts`.
- **`service/device-manager.ts`** — `DeviceManager` is the single entry point for connected-target discovery (real devices + running emulators) and friendly-name / device-type lookup. Consumed by `commands/device.ts` and `utils/hilog-adapter.ts`.
- **`commands/log.ts`** — Thin shell over `HilogAdapter`: `--crash` switches to crash dump; otherwise common hilog with `--level` / `--bundle-name` / `--keyword` filters. `--from <s|m>` / `--to <s|m>` carve a relative time window (default unit is seconds), `--tail <n>` keeps the latest N lines of the filtered output, and `--follow` streams in real time (incompatible with `--to`).
- **`commands/skills.ts`** + **`skills/`** — `list` / `find` / `add` / `remove`. `remove` uses `--skill <name>` (option form, not positional). `list` supports `-l, --long` for detailed output. Downloads skill `.zip`s and extracts them into per-agent paths defined in `config/constants.ts → AGENT_SKILLS_CONFIG` (e.g. `~/.claude/skills/`, `~/.cursor/skills/`) and / or `<project>/.deveco/skills/`. With neither `--agent` nor `--project`, operates on every detected agent. The shared agent helpers (`parseAgentList` / `getAllExistingAgents` / `summarizeOperationResults`) live in `skills/agents.ts` so `init` can reuse them.
- **`commands/init.ts`** — `devecocli init`. Two mutually exclusive modes: **`--skill`** (default) installs the bundled `deveco-cli` skill into per-agent / project paths, reusing `installLocalSkillToAgent` / `installLocalSkillToProjectAgent` / `installLocalSkillToPath`. **`--mcp`** configures the `deveco-mcp` MCP server (syntax checking) into agent config files via `installMcpConfigToAgentGlobal` / `installMcpConfigToAgentProject`. `--skill` and `--mcp` are mutually exclusive. `--force` is the overwrite / skip-validation switch (does not change global / project-level mode). `--mcp` without `--project` configures global MCP for all agents; `--mcp --project <path>` configures project-level MCP. Same `--agent` (comma-separated) / `--project` / `--path` / `-f` semantics as `skills add`.
- **`commands/serve.ts`** — `devecocli serve mcp`. Starts a stdio-based MCP server (ArkTS/C++ syntax checking via LSP). Reads `PROJECT_PATH`, `DEVECO_PATH`, `NODE_MAX_OLD_SPACE_SIZE` (default 8192), `DEBUG` from env. Delegates to `mcp/src-server/index.ts → createMcpServer`. Handles SIGINT/SIGTERM/SIGBREAK for clean shutdown.
- **`commands/doc.ts`** — Local HarmonyOS documentation search. Subcommands: `search <keywords...>` (with `--catalog`, `--format json|default`, `--limit`), `read <documentId>`, `catalog`. `search`/`read`/`catalog` call `awaitDocReady()` first (spinner while postinstall installs index in background). Search uses SQLite FTS5 + jieba via `service/doc-index/sqlite-index.ts` (`better-sqlite3` downloaded at postinstall); `docs read` streams markdown from bundled `docs.zip` via `docs-zip-reader.ts`. postinstall extracts prebuilt `index.zip` only (not `docs.zip`); index lifecycle in `service/doc-initializer.ts` (no public init subcommand). Publish with `npm run build:index` when regenerating `index.zip`.
- **`commands/update.ts`** — `npm install -g <package>@latest` (package name from `process.env.npm_package_name`, falling back to `deveco-cli`). On success, prompts that docs may update in background.
- **`utils/project.ts`** — `Project.discover(startDir)` walks up to find the project-level `build-profile.json5` (one containing `app`). Provides `getModuleType` (`entry`/`feature`/`shared`/`har`), `collectNonHarDependentModuleList`, `findArtifactPath(moduleName, target, isEmulator, product)`, `getBundleName`, `getMainAbility`.
- **`utils/template-provider.ts`** — Copies `templates/application/` into the target directory, replaces the seed `MyApplication` / `com.example.myapplication` placeholders with the user's `appName` / `bundleName`, and rewrites `sdkVersion` / `modelVersion` per the `API_CONFIGS` table. Performs a post-copy integrity check against an internal `REQUIRED_FILES` list and falls back to placeholder PNGs when the bundled DevEco Studio template assets are unavailable.
- **`utils/tool-provider.ts`** — Locates DevEco Studio and resolves `nodePath` / `ohpmJsPath` / `hvigorJsPath` / `javaPath` / `hdcPath` / `emulatorPath` / `sdkPath` (hilog is not a separate executable here — it runs through `hdc shell hilog`). Also exposes `detectApiLevel()` consumed by `create`, and enforces minimum DevEco Studio version `6.1.0` by reading `product-info.json` (Windows) or `Contents/Info.plist` then `Contents/product-info.json` (macOS).
  - **Windows**: registry (`HKLM\…\Uninstall\DevEco Studio`, then `HKLM\…\WOW6432Node\Huawei\DevEco Studio`), then default `C:\Program Files\Huawei\DevEco Studio`.
  - **macOS**: scans `~/Applications` and `/Applications` for any `*DevEco*.app` bundle.
  - **Linux**: not yet supported.
- **`utils/{ohpm,hvigor}-adapter.ts`** — Spawn the bundled `node` against `pm-cli.js` / `hvigorw.js` with the right env (`PATH` prepended with the bundled JBR `bin`, `DEVECO_SDK_HOME` set).
- **`utils/hdc-adapter.ts`** — Wraps the bundled `hdc` for device discovery, file-push install (`file send` + `bm install -p`), and ability launch.
- **`utils/hilog-adapter.ts`** — Reuses `hdc shell hilog` (and `hdc shell hidumper` for crashes) to fetch logs and post-filters them via `common-utils.ts`.
- **`utils/hdc-param.ts`** — Wraps `hdc shell param get` (single + batched). Returns clean values to callers, transparently swallowing hdc's failure / "channel-still-establishing" chatter (with retry).
- **`utils/text-table.ts`** — Fixed-width table renderer shared by `device list`, `emulator list` and `emulator image list`.
- **`utils/common-utils.ts`** — Shared validators (bundle name, hilog level, crash filename) and parsers (positive integer, duration `s`/`m`, time-window log filter, tail).
- **`utils/spinner-helper.ts` / `utils/ora-fail.ts`** — Small ora helpers for stateful spinner reuse and uniform "list command failed" exits.
- **`utils/logger.ts`** — `debugLog` only prints when `DEVECO_CLI_DEBUG=1`; useful for inspecting the raw command lines being spawned.
- **`utils/emulator-license.ts`** — Emulator SDK license agreement helpers (check / accept / view).
- **`utils/build-lock.ts`** — Per-project file lock (via `proper-lockfile`) used by `build` and `run` to serialise builds.

### MCP Server

`mcp/src-server/` is a bundled stdio MCP server providing ArkTS and C/C++ syntax checking via LSP.

- **`server.ts`** (`DevecoCliMcpServer`) — orchestrator; receives configuration (`projectPath`, `devecoPath`, `nodeMaxOldSpaceSize`, `debug`) via `createMcpServer`.
- **`tools/arkts-check.ts`** — ArkTS syntax check via DevEco LSP (`.ets` files).
- **`tools/cpp-check.ts`** — C/C++ syntax check via clangd.
- **`lsp/`** — Full LSP client: `ArktsLspManager.ts` (process lifecycle), `LspServerProxy.ts` (protocol proxy), `core/` (client, callbacks, diagnostics), `parse/` (JSON5 config parsers), `sync/` (ohpm install + build), `watcher/` (file/dependency watchers).
- Started by `devecocli serve mcp` or configured into agents via `devecocli init --mcp`.

### SKILL.md

`SKILL.md` is consumed by AI agents to learn how to invoke `devecocli`.

## Technology Stack

- **Language**: TypeScript (strict, ESM, target Node.js >= 18)
- **Modules**: ES Modules (`"type": "module"`); internal imports must use `.js` even though sources are `.ts`
- **Build**: `tsup` (single minified ESM `dist/cli.js`, `shims: true`, with `npm_package_version` / `npm_package_name` injected at build time)
- **CLI framework**: Commander.js
- **Runtime deps**: `commander`, `execa`, `axios`, `json5`, `regedit`, `fs-extra`, `adm-zip`, `colorette`, `ora`, `global-agent` (proxy support, bootstrapped in `cli.ts`), `@modelcontextprotocol/sdk`, `@node-rs/jieba`, `unified`, `remark-parse`, `remark-gfm`, `mdast-util-to-string`, `proper-lockfile`, `yauzl`, `zod`. **Optional**: `better-sqlite3` (native module; prebuild downloaded in `postinstall` via `scripts/install-better-sqlite3.mjs` for the current Node ABI).
- **Dev tooling**: `eslint` (typescript-eslint), `prettier`, `tsx`, `tsup`, `generate-license-file`, `@eslint/js`, `typescript`, `turndown`, `husky`, type stubs (`@types/adm-zip`, `@types/fs-extra`, `@types/global-agent`, `@types/turndown`, `@types/node`)
- **Lint rules**: `curly` (all), `max-lines-per-function` (50), `max-depth` (4), `dot-notation`
- **Prettier**: `semi: true`, `singleQuote: true`, `trailingComma: es5`

## CLI Conventions

- **kebab-case for long options** (`--build-mode`, `--bundle-name`). No camelCase / underscore in user-facing flags.
- **`--device <name|serial>` accepts name OR serial** (substring match for name, exact match for serial like `127.0.0.1:5555`). For `device view`, the equivalent is `-t, --target <serial>`. Docs should describe `--device` as "name or serial".
- **Multi-device hosts** must list available serials and exit non-zero rather than silently picking one when no device flag is given.
- **`devecocli init` mode flags**: `--skill` (skill only) and `--mcp` (MCP config only) are mutually exclusive. Default (no flag) = `--skill`. `--force` is the overwrite / skip-validation switch only; it does not change global / project-level mode.
- **MCP global / project-level**: `--mcp` without `--project` configures global MCP for supported agents (except Qoder). `--mcp --project <path>` configures project-level MCP for supported agents (except Qoder).
- **When adding a new flag / command**, update the matching prose section in `SKILL.md` and `README.md`'s command overview.

## Development Notes

- Node.js >= 18 (runtime and build target).
- Output bundle: `dist/cli.js` (bin: `devecocli`).
- HarmonyOS project config is JSON5 (`build-profile.json5`, `module.json5`, `oh-package.json5`, `app.json5`).
- `DEVECO_CLI_DEBUG=1` logs the raw `node` / `ohpm` / `hvigor` / `hdc` / `emulator` invocations (hilog is fetched via `hdc shell hilog`).
- `DEVECO_CLI_SKIP_VERSION_CHECK=1` bypasses the DevEco Studio version check at startup.
