# Agents.md

Guidance for AI coding assistants working in this repo.

## Project Overview

**deveco-cli** wraps the DevEco Studio toolchain (`ohpm`, `hvigor`, `hdc`, `emulator`, `hilog`, bundled `node` + JBR + SDK) plus Huawei Developer login, HarmonyOS knowledge search, the HMOS skills installer, and a project-scaffolding template engine — all behind a single `devecocli` binary, with no need to set `PATH` / `DEVECO_SDK_HOME` / `JAVA_HOME`.

Capabilities: scaffold a new application project from the bundled template (`create`), build & package (`.hap` / `.hsp` / `.har` / `.app`), manage devices and emulators, install + launch (`run`), fetch `hilog` / crash logs, query the ArkTS knowledge base, install / remove HMOS skills for AI agents (Claude, Cursor, Gemini, OpenCode, …), and self-update.

Distribution: a single ESM bundle (`dist/cli.js`), exposed as the `devecocli` bin.

## Commonly Used Commands

```bash
npm run build      # tsup → dist/cli.js, then regenerates SKILL.md from SKILL_TEMP.md
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

```
src/
├── cli.ts                    # Entry point; registers all commands with Commander
├── commands/                 # One file per CLI subcommand
│   ├── create.ts             # Scaffold a new project from templates/application
│   ├── build.ts   run.ts   update.ts
│   ├── device.ts  emulator.ts  log.ts
│   ├── login.ts   logout.ts   whoami.ts
│   └── knowledge.ts  skills.ts  init.ts
├── auth/                     # Huawei Developer OAuth + token lifecycle
│   ├── login-service.ts             # Top-level orchestrator (login / logout / status)
│   ├── local-auth-server.ts         # Localhost HTTP callback for the OAuth redirect
│   ├── token-storage.ts             # Persist / load token bundles on disk
│   ├── token-checker.ts             # JWT-token validity check + refresh
│   └── user-info-fetcher.ts         # Exchange tempToken→jwtToken + parse user info
├── skills/                   # HMOS skills marketplace client (api + installer + agents)
│   ├── api.ts                       # HMOS skills HTTP client + installed-agent discovery
│   ├── installer.ts                 # Download / extract / remove skill packages
│   └── agents.ts                    # parseAgentList / getAllExistingAgents / summarizeOperationResults
├── service/                  # Domain helpers
│   ├── device-manager.ts            # Connected-device discovery + name / device-type lookup
│   ├── emulator-types.ts            # `EmulatorInfo` + `normalizeListNameKey`
│   ├── emulator-list-parse.ts       # Parses `emulator -list -details` (JSON / text)
│   ├── emulator-start-strategies.ts # Builds `-start` / `-hvd` argv candidates + retries
│   └── emulator-manager.ts          # list/start/stop + image + create/delete virtual device
├── utils/
│   ├── project.ts                  # Project discovery + JSON5 build-profile parsing
│   ├── tool-provider.ts            # Locate DevEco Studio + resolve toolchain paths
│   ├── template-provider.ts        # Copy templates/application + render API-level fields
│   ├── ohpm-adapter.ts   hvigor-adapter.ts
│   ├── hdc-adapter.ts    hilog-adapter.ts    hdc-param.ts
│   ├── emulator-spawn.ts           # Detached Emulator.exe spawn + Windows shell quoting
│   ├── emulator-hdc-targets.ts     # `hdc list targets` filter for emulator serials
│   ├── emulator-image-list-parse.ts # Parses `emulator -imageList` JSON for downloaded osVersions
│   ├── knowledge.ts                # Knowledge query normalization + ranking
│   ├── common-utils.ts             # Shared validators (bundle / level / crash / duration / tail)
│   ├── spinner-helper.ts           # Stateful ora wrapper (start / stop / succeed / fail)
│   ├── ora-fail.ts                 # `exitWithListCommandError` helper
│   ├── text-table.ts               # Fixed-width table renderer used by `list` commands
│   ├── http-client.ts  jwt.ts  browser.ts  cmd.ts  config.ts  region.ts
│   └── logger.ts                   # debugLog (gated by DEVECO_CLI_DEBUG)
├── config/                   # constants (AGENT_SKILLS_CONFIG), auth, network, skills
└── types/                    # Shared type defs

templates/application/        # Project scaffold copied by `devecocli create`
scripts/update-skill-docs.ts  # Inlines `devecocli --help` into SKILL.md
SKILL.md                      # Auto-generated; do NOT edit by hand
SKILL_TEMP.md                 # Edit this; SKILL.md is regenerated from it on build
```

### Key Components

- **`cli.ts`** — Commander entry; bootstraps `global-agent` to honour HTTP_PROXY env vars, registers 13 subcommands. `--version` is read from `process.env.npm_package_version` (injected by tsup). Also normalizes `devecocli <command> help` to `devecocli <command> --help` for leaf commands. Calls `ToolProvider.checkVersion()` on startup unless `DEVECO_CLI_SKIP_VERSION_CHECK=1`.
- **`commands/create.ts`** — Scaffolds a new application project. Requires `--app-name` (1–200 chars, letter-start, letters/digits/underscores only). `--project-path` defaults to `./<app-name>` (the auto path must not exist; an explicit `--project-path` may point at an existing directory only if it is empty). Path normalization: backslashes → forward slashes (Windows); consecutive slashes reduced to single. Deep paths auto-created with `mkdir -p` semantics; the closest existing parent must be writable. Validates `--bundle-name` (7–128 chars, ≥3 dot-separated segments, no consecutive dots). `--api-level` validated to `17`–`23` or auto-detected; defaults to `23` if DevEco Studio not found. Delegates file copy + config rendering to `utils/template-provider.ts`.
- **`commands/build.ts`** — Default action: pipeline `ohpm install --all → hvigor --sync → hvigor assemble*`. Auto-detects the entry module, resolves transitive HSP deps, and propagates `@target` suffixes. With `--product <name>` only, builds the whole-product `.app`; otherwise builds per-module `.hap` / `.hsp` / `.har`. Subcommand `build clean` runs `hvigor clean` to remove build outputs.
- **`commands/run.ts`** — Auto-selects the runnable module (`entry`/`feature`/`shared`) and the device (name substring or exact serial), then installs HSP deps + the main `.hap` via `HdcAdapter.installApp` (which `hdc file send`s the artifacts to a temp dir and runs `hdc shell bm install -p`), and launches the ability (defaults to `mainElement` from `module.json5`).
- **`commands/device.ts`** — Subcommands: `list` (currently active real devices and running emulators, each annotated with its device type), `view` (detailed info), `install <packagePaths...>` (one or more `.hap`/`.hsp`; optional `-b/--bundle-name` + `-a/--ability` to launch after install), `uninstall <bundleName>`. Multi-device hosts must pass `-t <serial>` to `view` / `install` / `uninstall`. Use `devecocli emulator list` to see installed-but-stopped emulators.
- **`commands/emulator.ts`** — CLI for local emulator `list` / `start` / `stop` / `create` / `delete` plus system-image helpers under `image`: `download` / `remove` / `list`. `list` shows every instance with its status, serial and device type (running rows surfaced first). `image download` / `image remove` / `create` all require `--device-type` (one of `Phone`, `Foldable`, `WideFold`, `TripleFold`, `Tablet`, `2in1`, `2in1 Foldable`, `Wearable`, `TV`) and `--os-version`; `image list` accepts `--device-type`, `--all` (downloaded + not downloaded), and `--format table|json`.
- **`service/emulator-manager.ts`** — `EmulatorManager` orchestrates list/start/stop + system-image install/uninstall/list + create/delete local virtual devices. List parsing: `service/emulator-list-parse.ts`; start strategies: `service/emulator-start-strategies.ts`; detached spawn: `utils/emulator-spawn.ts`.
- **`service/device-manager.ts`** — `DeviceManager` is the single entry point for connected-target discovery (real devices + running emulators) and friendly-name / device-type lookup. Consumed by `commands/device.ts` and `utils/hilog-adapter.ts`.
- **`commands/log.ts`** — Thin shell over `HilogAdapter`: `--crash` switches to crash dump; otherwise common hilog with `--level` / `--bundle-name` / `--keyword` filters. `--from <s|m>` / `--to <s|m>` carve a relative time window (default unit is seconds), `--tail <n>` keeps the latest N lines of the filtered output, and `--follow` streams in real time (incompatible with `--to`).
- **`commands/knowledge.ts`** — Login-gated. Requires `--prompt <question>` and supports `--format md|markdown|json` (default `md`); `json` output is a JSON array of ranked answer chunks.
- **`commands/whoami.ts`** — Login status helper. Prints the current Huawei Developer username from the persisted token session, or exits non-zero when not logged in.
- **`commands/skills.ts`** + **`skills/`** — `list` / `find` / `add` / `remove`. `remove` uses `--skill <name>` (option form, not positional). Downloads skill `.zip`s and extracts them into per-agent paths defined in `config/constants.ts → AGENT_SKILLS_CONFIG` (e.g. `~/.claude/skills/`, `~/.cursor/skills-cursor/`) and / or `<project>/.deveco/skills/`. With neither `--agent` nor `--project`, operates on every detected agent. The shared agent helpers (`parseAgentList` / `getAllExistingAgents` / `summarizeOperationResults`) live in `skills/agents.ts` so `init` can reuse them.
- **`commands/init.ts`** — Top-level `devecocli init`. Installs the bundled `deveco-cli` skill (the file ships as `SKILL.md` at the package root; `resolveBundledSkillMdPath` in `skills/installer.ts` walks up from `import.meta.url` to find it) into per-agent / project paths under `<agent_skills_dir>/deveco-cli/`, reusing `installLocalSkillToAgent` / `installLocalSkillToProject`. Same `--agent` (comma-separated) / `--project` / `-f` semantics as `skills add`.
- **`commands/login.ts` / `logout.ts`** — Wrap `auth/login-service.ts`, which opens the OAuth URL in the browser, runs a localhost callback server (`local-auth-server.ts`), exchanges the code via `user-info-fetcher.ts`, validates / refreshes JWTs through `token-checker.ts`, and persists tokens (`token-storage.ts`).
- **`commands/update.ts`** — `npm install -g <package>@latest` (package name from `process.env.npm_package_name`, falling back to `deveco-cli`).
- **`utils/project.ts`** — `Project.discover(startDir)` walks up to find the project-level `build-profile.json5` (one containing `app`). Provides `getModuleType` (`entry`/`feature`/`shared`/`har`), `resolveHspDependencies`, `findArtifactPath(module, target, isEmulator, product)`, `getBundleName`, `getMainAbility`.
- **`utils/template-provider.ts`** — Copies `templates/application/` into the target directory, replaces the seed `MyApplication` / `com.example.myapplication` placeholders with the user's `appName` / `bundleName`, and rewrites `sdkVersion` / `modelVersion` per the `API_CONFIGS` table (API levels 17-23). Performs a post-copy integrity check against an internal `REQUIRED_FILES` list and falls back to placeholder PNGs when the bundled DevEco Studio template assets are unavailable.
- **`utils/tool-provider.ts`** — Locates DevEco Studio and resolves `nodePath` / `ohpmJsPath` / `hvigorJsPath` / `javaPath` / `hdcPath` / `emulatorPath` / `sdkPath` (hilog is not a separate executable here — it runs through `hdc shell hilog`). Also exposes `detectApiLevel()` consumed by `create`, and enforces minimum DevEco Studio version `6.1.0` by reading `product-info.json` (Windows) or `Contents/Info.plist` then `Contents/product-info.json` (macOS).
  - **Windows**: registry (`HKLM\…\Uninstall\DevEco Studio`, then `HKLM\…\WOW6432Node\Huawei\DevEco Studio`), then default `C:\Program Files\Huawei\DevEco Studio`.
  - **macOS**: scans `~/Applications` and `/Applications` for any `*DevEco*.app` bundle.
  - **Linux**: not yet supported.
- **`utils/{ohpm,hvigor}-adapter.ts`** — Spawn the bundled `node` against `pm-cli.js` / `hvigorw.js` with the right env (`PATH` prepended with the bundled JBR `bin`, `DEVECO_SDK_HOME` set).
- **`utils/hdc-adapter.ts`** — Wraps the bundled `hdc` for device discovery, file-push install (`file send` + `bm install -p`), and ability launch.
- **`utils/hilog-adapter.ts`** — Reuses `hdc shell hilog` (and `hdc shell hilog -x` for crashes) to fetch logs and post-filters them via `common-utils.ts`.
- **`utils/hdc-param.ts`** — Wraps `hdc shell param get` (single + batched). Returns clean values to callers, transparently swallowing hdc's failure / "channel-still-establishing" chatter (with retry).
- **`utils/text-table.ts`** — Fixed-width table renderer shared by `device list`, `emulator list` and `emulator image list`.
- **`utils/common-utils.ts`** — Shared validators (bundle name, hilog level, crash filename) and parsers (positive integer, duration `s`/`m`, time-window log filter, tail).
- **`utils/spinner-helper.ts` / `utils/ora-fail.ts`** — Small ora helpers for stateful spinner reuse and uniform "list command failed" exits.
- **`utils/logger.ts`** — `debugLog` only prints when `DEVECO_CLI_DEBUG=1`; useful for inspecting the raw command lines being spawned.

### Skill Documentation Pipeline

`SKILL.md` is consumed by AI agents (Cursor, Claude, …) to learn how to invoke `devecocli`. **Edit `SKILL_TEMP.md`, not `SKILL.md`.** On every build, `scripts/update-skill-docs.ts` runs each placeholder block:

```
<!-- EXEC_START: node ./dist/cli.js --help -->
<!-- EXEC_END -->
```

…and inlines the command's stdout (wrapped in a ` ```text ` fence) into `SKILL.md`. The script runs each command with `DEVECO_CLI_SKIP_VERSION_CHECK=1` so doc generation never blocks on a missing DevEco Studio install. Today the template only embeds the top-level `--help`; per-subcommand details are described in prose. When you add or change a flag / subcommand, update the relevant prose section (and add another `EXEC_START` block if you want the raw `--help` text inlined too).

## Technology Stack

- **Language**: TypeScript (strict, ESM, target Node.js >= 18)
- **Modules**: ES Modules (`"type": "module"`); internal imports must use `.js` even though sources are `.ts`
- **Build**: `tsup` (single minified ESM `dist/cli.js`, `shims: true`, with `npm_package_version` / `npm_package_name` injected at build time; `onSuccess` runs `scripts/update-skill-docs.ts`)
- **CLI framework**: Commander.js
- **Runtime deps**: `commander`, `execa`, `axios`, `json5`, `regedit`, `fs-extra`, `adm-zip`, `string-similarity-js` (knowledge ranking), `colorette`, `ora`, `global-agent` (proxy support, bootstrapped in `cli.ts`), `natural`
- **Dev tooling**: `eslint`, `typescript-eslint`, `prettier`, `tsx`, `tsup`, `generate-license-file`

## CLI Conventions

- **kebab-case for long options** (`--build-mode`, `--bundle-name`). No camelCase / underscore in user-facing flags.
- **`--device <name|serial>` accepts name OR serial** (substring match for name, exact match for serial like `127.0.0.1:5555`). For `device view` / `device install` / `device uninstall`, the equivalent is `-t, --target <serial>` (serial only). Docs should describe `--device` as "name or serial".
- **Login-gated commands** must call `loginService.isLoggedIn()` first and print a clear `Please login first` on false.
- **Multi-device hosts** must list available serials and exit non-zero rather than silently picking one when no device flag is given.
- **When adding a new flag / command**, update the matching prose section in `SKILL_TEMP.md` and `README.md`'s command overview. If you want raw `--help` text inlined into `SKILL.md`, add an `EXEC_START` block too.

## Development Notes

- Node.js >= 18.
- Output bundle: `dist/cli.js` (bin: `devecocli`).
- HarmonyOS project config is JSON5 (`build-profile.json5`, `module.json5`, `oh-package.json5`, `app.json5`).
- `DEVECO_CLI_DEBUG=1` logs the raw `node` / `ohpm` / `hvigor` / `hdc` / `emulator` invocations (hilog is fetched via `hdc shell hilog`).
- `DEVECO_CLI_SKIP_VERSION_CHECK=1` bypasses the DevEco Studio version check at startup (used by `scripts/update-skill-docs.ts`).
