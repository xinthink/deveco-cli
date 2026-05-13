# Agents.md

Guidance for AI coding assistants working in this repo.

## Project Overview

**deveco-cli** wraps the DevEco Studio toolchain (`ohpm`, `hvigor`, `hdc`, `emulator`, `hilog`, bundled `node` + JBR + SDK) plus Huawei Developer login, HarmonyOS knowledge search, the HMOS skills installer, and a project-scaffolding template engine — all behind a single `deveco` binary, with no need to set `PATH` / `DEVECO_SDK_HOME` / `JAVA_HOME`.

Capabilities: scaffold a new application project from the bundled template (`create`), build & package (`.hap` / `.hsp` / `.har` / `.app`), manage devices and emulators, install + launch (`run`), fetch `hilog` / crash logs, query the ArkTS knowledge base, install / remove HMOS skills for AI agents (Claude, Cursor, Gemini, OpenCode, …), and self-update.

Distribution: a single ESM bundle (`dist/cli.js`), exposed as the `deveco` bin.

## Commonly Used Commands

```bash
npm run build      # tsup → dist/cli.js, then regenerates SKILL.md from SKILL_TEMP.md
npm run dev        # tsx watch mode
npm start          # tsx (one-shot, no build)
npm run lint       # eslint (--fix to autofix)
npm run format     # prettier
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
│   ├── login.ts   logout.ts
│   └── knowledge.ts  skills.ts
├── auth/                     # Huawei Developer OAuth + token lifecycle
├── skills/                   # HMOS skills marketplace client (api + installer)
├── service/                  # Domain helpers
│   ├── emulator-service.ts          # Used by `device` flow (devices + emulators discovery)
│   ├── emulator-types.ts            # `EmulatorInfo` + `normalizeListNameKey`
│   ├── emulator-list-parse.ts       # Parses `emulator -list -details` (JSON / text)
│   ├── emulator-start-strategies.ts # Builds `-start` / `-hvd` argv candidates + retries
│   └── emulator-manager.ts          # listEmulators / startEmulator / stopEmulator
├── utils/
│   ├── project.ts            # Project discovery + JSON5 build-profile parsing
│   ├── tool-provider.ts      # Locate DevEco Studio + resolve toolchain paths
│   ├── template-provider.ts  # Copy templates/application + render API-level fields
│   ├── ohpm-adapter.ts   hvigor-adapter.ts
│   ├── hdc-adapter.ts    hilog-adapter.ts    hdc-param.ts
│   ├── emulator-spawn.ts          # Detached Emulator.exe spawn + Windows shell quoting
│   ├── emulator-hdc-targets.ts    # `hdc list targets` filter for emulator serials
│   ├── knowledge.ts          # Knowledge query normalization + ranking
│   ├── http-client.ts  jwt.ts  browser.ts  cmd.ts  config.ts  region.ts
│   └── logger.ts             # debugLog (gated by DEVECO_CLI_DEBUG)
├── config/                   # constants (AGENT_SKILLS_CONFIG), auth, network, skills
└── types/                    # Shared type defs

templates/application/        # Project scaffold copied by `deveco create`
scripts/update-skill-docs.ts  # Inlines `deveco <cmd> --help` into SKILL.md
SKILL.md                      # Auto-generated; do NOT edit by hand
SKILL_TEMP.md                 # Edit this; SKILL.md is regenerated from it on build
```

### Key Components

- **`cli.ts`** — Commander entry; registers 11 subcommands. `--version` is read from `process.env.npm_package_version` (injected by tsup).
- **`commands/create.ts`** — Scaffolds a new application project. Requires `--app-name` (1–200 chars, letter-start, letters/digits/underscores only). `--project-path` defaults to `./<app-name>`; errors if directory exists. Path normalization: backslashes → forward slashes; consecutive slashes reduced to single. Deep paths auto-created with `mkdir -p` semantics. Validates `--bundle-name` (7–128 chars, ≥3 dot-separated segments, no consecutive dots). `--api-level` validated to `17`–`23` or auto-detected; defaults to `23` if DevEco Studio not found. Delegates file copy + config rendering to `utils/template-provider.ts`.
- **`commands/build.ts`** — Pipeline `ohpm install --all → hvigor --sync → hvigor assemble*`. Auto-detects the entry module, resolves transitive HSP deps, and propagates `@target` suffixes. With `--product <name>` only, builds the whole-product `.app`; otherwise builds per-module `.hap` / `.hsp` / `.har`.
- **`commands/run.ts`** — Auto-selects the runnable module (`entry`/`feature`/`shared`) and the device (name substring or exact serial), installs HSP deps then the main `.hap` via `hdc install -r`, and `aa start`s the ability (defaults to `mainElement` from `module.json5`).
- **`commands/device.ts`** — `--list` / `--info` / `--install` (multi-package, dep-first) / `--uninstall`, all via `hdc`. Multi-device hosts must pass `-t <serial>`.
- **`commands/emulator.ts`** — Thin CLI layer for `list` / `start <names...>` / `stop <name>`. `list` merges `EmulatorManager.listEmulators()` with `hdc list targets` (via `utils/emulator-hdc-targets.ts`) to attach a `[serial]` to running instances. `start` accepts multiple names (quote those with spaces) and runs them in parallel via `Promise.allSettled`; success is reported only once `hdc list targets` shows the instance (matched via `ohos.qemu.hvd.name`).
- **`service/emulator-manager.ts`** — `EmulatorManager` orchestrates `listEmulators` / `startEmulator` / `stopEmulator`. Delegates list parsing to `service/emulator-list-parse.ts` and start strategy selection to `service/emulator-start-strategies.ts`; uses `utils/emulator-spawn.ts` for the actual detached spawn (incl. Windows shell quoting fallback).
- **`service/emulator-service.ts`** — Used by the `device` discovery flow to enumerate connected devices and installed emulators. This is separate from `commands/emulator.ts`, which implements the `deveco emulator` subcommand.
- **`commands/log.ts`** — Thin shell over `HilogAdapter`: `--crash` switches to crash dump; otherwise common hilog with `--level` / `--bundle-name` / `--keyword` filters.
- **`commands/knowledge.ts`** — Login-gated. Normalizes `--keywords` (multi-word, no quotes) and prints the ranked answers as a JSON array.
- **`commands/skills.ts`** + **`skills/`** — `list` / `find` / `add` / `remove`. Downloads skill `.zip`s and extracts them into per-agent paths defined in `config/constants.ts → AGENT_SKILLS_CONFIG` (e.g. `~/.claude/skills/`, `~/.cursor/skills-cursor/`) and / or `<project>/.deveco/skills/`. With neither `--agent` nor `--project`, operates on every detected agent. The shared agent helpers (`parseAgentList` / `getAllExistingAgents` / `summarizeOperationResults`) live in `skills/agents.ts` so `init` can reuse them.
- **`commands/init.ts`** — Top-level `deveco init`. Installs the bundled `deveco-cli` skill (the file ships as `SKILL.md` at the package root; `resolveBundledSkillMdPath` in `skills/installer.ts` walks up from `import.meta.url` to find it) into per-agent / project paths under `<agent_skills_dir>/deveco-cli/`, reusing `installLocalSkillToAgent` / `installLocalSkillToProject`. Same `--agent` / `--project` / `-f` semantics as `skills add`.
- **`commands/login.ts` / `logout.ts`** — Wrap `auth/login-service.ts`, which opens the OAuth URL in the browser, runs a localhost callback server (`local-auth-server.ts`), exchanges the code, fetches the user profile, and persists tokens (`token-storage.ts`).
- **`commands/update.ts`** — `npm install -g <package>@latest` (package name from `process.env.npm_package_name`, falling back to `deveco-cli`).
- **`utils/project.ts`** — `Project.discover(startDir)` walks up to find the project-level `build-profile.json5` (one containing `app`). Provides `getModuleType` (`entry`/`feature`/`shared`/`har`), `resolveHspDependencies`, `findArtifactPath(module, target, isEmulator, product)`, `getBundleName`, `getMainAbility`.
- **`utils/template-provider.ts`** — Copies `templates/application/` into the target directory, fills `appName` / `bundleName` placeholders, and rewrites `sdkVersion` / `modelVersion` per the `API_CONFIGS` table (API levels 17-23). Also exposes `REQUIRED_FILES` used by `create` for the post-copy integrity check.
- **`utils/tool-provider.ts`** — Locates DevEco Studio and resolves `nodePath` / `ohpmJsPath` / `hvigorJsPath` / `javaPath` / `hdcPath` / `emulatorPath` / `hilogPath` / `sdkPath`. Also exposes `detectApiLevel()` consumed by `create`.
  - **Windows**: registry (`HKLM\…\Uninstall\DevEco Studio`, then `HKLM\…\WOW6432Node\Huawei\DevEco Studio`), then default `C:\Program Files\Huawei\DevEco Studio`.
  - **macOS**: `~/Applications/DevEco-Studio.app`, then `/Applications/DevEco-Studio.app`.
  - **Linux**: not yet supported.
- **`utils/{ohpm,hvigor,hdc,hilog}-adapter.ts`** — Spawn the corresponding tool with the right env (`PATH` prepended with the bundled JBR `bin`, `DEVECO_SDK_HOME` set).
- **`utils/logger.ts`** — `debugLog` only prints when `DEVECO_CLI_DEBUG=1`; useful for inspecting the raw command lines being spawned.

### Skill Documentation Pipeline

`SKILL.md` is consumed by AI agents (Cursor, Claude, …) to learn how to invoke `deveco`. **Edit `SKILL_TEMP.md`, not `SKILL.md`.** On every build, `scripts/update-skill-docs.ts` runs each placeholder block:

```
<!-- EXEC_START: node ./dist/cli.js --help -->
<!-- EXEC_END -->
```

…and inlines the command's stdout (wrapped in a ` ```text ` fence) into `SKILL.md`. When adding a new flag / subcommand, add a matching `EXEC_START` block plus a short prose description in `SKILL_TEMP.md`.

## Technology Stack

- **Language**: TypeScript (strict, ESM, target Node.js >= 18)
- **Modules**: ES Modules (`"type": "module"`); internal imports must use `.js` even though sources are `.ts`
- **Build**: `tsup` (single minified `dist/cli.js`, with `npm_package_version` / `npm_package_name` injected at build time)
- **CLI framework**: Commander.js
- **Runtime deps**: `commander`, `execa`, `axios`, `json5`, `regedit`, `fs-extra`, `adm-zip`, `string-similarity-js` (knowledge ranking), `colorette`, `ora`
- **Dev tooling**: `eslint`, `typescript-eslint`, `prettier`, `tsx`, `tsup`, `generate-license-file`

## CLI Conventions

- **kebab-case for long options** (`--build-mode`, `--bundle-name`). No camelCase / underscore in user-facing flags.
- **`--device` / `-d` accepts name OR serial** (substring match for name, exact match for serial like `127.0.0.1:5555`). For `device`, the equivalent is `-t, --target <serial>` (serial only). Docs should describe `--device` as "name or serial".
- **Login-gated commands** must call `loginService.isLoggedIn()` first and print a clear `Please login first` on false.
- **Multi-device hosts** must list available serials and exit non-zero rather than silently picking one when no device flag is given.
- **When adding a new flag / command**, update both `SKILL_TEMP.md` (with an `EXEC_START` block) and `README.md`'s command overview.

## Development Notes

- Node.js >= 18.
- Output bundle: `dist/cli.js` (bin: `deveco`).
- HarmonyOS project config is JSON5 (`build-profile.json5`, `module.json5`, `oh-package.json5`, `app.json5`).
- `DEVECO_CLI_DEBUG=1` logs the raw `node` / `ohpm` / `hvigor` / `hdc` / `hilog` invocations.
