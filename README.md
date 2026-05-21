# deveco-cli

> HarmonyOS application development command line tool.

`devecocli` is a unified CLI wrapper around the DevEco Studio toolchain — `ohpm`, `hvigor`, `hdc`, `emulator`, `hilog` — plus Huawei Developer login, the HMOS skills installer, and a project-scaffolding template. Drive the full HarmonyOS workflow (create → build → install → run → log → install AI skills) from one binary, with no `PATH` / `DEVECO_SDK_HOME` / `JAVA_HOME` setup.

## Quick Start

**Prerequisites:** Node.js >= 18, DevEco Studio installed (Windows or macOS).

> Not published yet — until then, build from source (see [Development](#development)) and run `node ./dist/cli.js`. After release, self-update via `devecocli update`.

End-to-end on the command line:

```bash
devecocli create --app-name MyApp   # scaffold (default path: ./MyApp)
cd MyApp
devecocli build                                            # package .hap
devecocli run                                              # install + launch
devecocli log --level E                                    # tail logs
```

Run any command with `--help` for full options. Set `DEVECO_CLI_DEBUG=1` to print the raw underlying tool invocations.

### Drive devecocli from an AI agent (opencode example)

Instead of typing the commands above by hand, let an agent (`opencode`, `claude`, `cursor`, …) drive `devecocli` for you. The flow below uses [opencode](https://opencode.ai/):

1. **Teach the agent how `devecocli` works** — install the bundled `deveco-cli` skill into opencode:

   ```bash
   devecocli init --agent opencode
   # writes the skill to ~/.config/opencode/skills/deveco-cli/
   ```

   (Run `devecocli init` with no flags to install into every detected agent at once.)

2. **Open a project and start opencode**:

   ```bash
   cd MyApp        # any HarmonyOS project (with build-profile.json5 / oh-package.json5)
   opencode
   ```

3. **Ask in natural language** — opencode auto-loads the `deveco-cli` skill and turns prompts like the following into the right `devecocli` invocations:

   - `Scaffold a new HarmonyOS app called Demo at ./Demo and build it`
   - `Build this project in release mode and run it on my emulator`
   - `Tail the last error logs from this app`

If the agent doesn't pick up the skill automatically, prompt it explicitly: *"Use the `deveco-cli` skill."*

## Commands

| Command | Purpose |
| --- | --- |
| `devecocli create` | Scaffold a new HarmonyOS application project from the bundled template |
| `devecocli build` | Build / package a project or modules into `.hap` / `.hsp` / `.har` / `.app`; `build clean` removes build outputs |
| `devecocli run` | Install (with HSP deps) and launch on a device / emulator |
| `devecocli device` | List / inspect connected devices and emulators; install / uninstall `.hap` / `.hsp` packages |
| `devecocli emulator` | Manage local emulators: list / start / stop / create / delete, system images (`image download|remove|list`), and license helpers (`license view` / `license accept`) |
| `devecocli log` | Fetch hilog or crash logs (with level / bundle / keyword / from/to / tail / follow filters) |
| `devecocli verify` | Run UI verification on a connected device using a natural-language test plan; outputs a structured JSON result with pass/fail details and a task ID. Use `verify log` to retrieve execution logs and `verify screenshot` to save step-by-step screenshots by task ID. **Before first use, run `devecocli verify config --base-url <url> --model-name <name> --api-key <key>` to configure the vision model.** |
| `devecocli whoami` | Show the currently logged-in Huawei Developer user |
| `devecocli init` | Install the bundled `deveco-cli` skill into your AI agents (`claude`, `cursor`, …) so they learn how to drive `devecocli` |
| `devecocli skills` | List / find / add / remove HMOS skills for AI agents and projects |
| `devecocli login` / `devecocli logout` | Sign in / out of a Huawei Developer account |
| `devecocli start mcp` | Start the bundled MCP (Model Context Protocol) server over stdio so AI clients (Trae / Claude / …) can call its `check` tool |
| `devecocli update` | Update the CLI itself (`npm install -g deveco-cli@latest`) |

Run `devecocli <cmd> --help` for full options, or see [`SKILL.md`](./SKILL.md) for the detailed reference (also consumed by AI agents).

Cross-platform: works on **Windows** and **macOS**; Linux is not yet supported (DevEco Studio's bundled toolchain isn't officially distributed for Linux).

## Development

```bash
npm install
npm run dev                  # Watch mode
npm start -- <command>       # tsx (no build step)
npm run lint                 # add :fix to autofix
npm run format
npm run build                # tsup → dist/cli.js, then regenerates SKILL.md from SKILL_TEMP.md
```

See [`AGENTS.md`](./AGENTS.md) for the architecture overview.

## License

[MIT](./LICENSE)
