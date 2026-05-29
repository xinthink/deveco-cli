# deveco-cli

> HarmonyOS application development command line tool.

`devecocli` is a unified CLI wrapper around the DevEco Studio toolchain — `ohpm`, `hvigor`, `hdc`, `emulator`, `hilog` — plus the HMOS skills installer, a project-scaffolding template, a local HarmonyOS documentation search service, and a bundled MCP server. Drive the full HarmonyOS workflow (create → build → install → run → log → install AI skills) from one binary, with no `PATH` / `DEVECO_SDK_HOME` / `JAVA_HOME` setup.

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

### Search offline documentation

```bash
devecocli docs search List                     # search by keyword
devecocli docs search @State @Prop --limit 10  # multi-keyword OR search
devecocli docs read harmonyos-guides/application-models/arkts-page-start-overview  # read a doc
devecocli docs catalog                         # list all catalogs
```

### Drive devecocli from an AI agent (opencode example)

Instead of typing the commands above by hand, let an agent (`opencode`, `claude`, `cursor`, …) drive `devecocli` for you. The flow below uses [opencode](https://opencode.ai/):

1. **Teach the agent how `devecocli` works** — install the bundled `deveco-cli` skill into opencode:

   ```bash
   devecocli init --agent opencode
   # writes the skill to ~/.config/opencode/skills/deveco-cli/
   ```

   (Run `devecocli init` with no flags to install into every detected agent at once.)

2. **Enable syntax checking** — configure the `deveco-mcp` MCP server for your project:

   ```bash
   devecocli init --mcp --project ./MyApp
   # writes MCP config to MyApp/.opencode/opencode.json, MyApp/.cursor/mcp.json, etc.
   ```

   The MCP server provides a unified `check` tool (auto-dispatches by file extension: `.ets` → ArkTS LSP, C/C++ → clangd) for syntax checking. Once configured, the AI agent will auto-spawn the MCP server when you open the project.

3. **Open a project and start opencode**:

   ```bash
   cd MyApp        # any HarmonyOS project (with build-profile.json5 / oh-package.json5)
   opencode
   ```

4. **Ask in natural language** — opencode auto-loads the `deveco-cli` skill and turns prompts like the following into the right `devecocli` invocations:

   - `Scaffold a new HarmonyOS app called Demo at ./Demo and build it`
   - `Build this project in release mode and run it on my emulator`
   - `Tail the last error logs from this app`
   - `Check for syntax errors in src/main/ets/pages/Index.ets`

If the agent doesn't pick up the skill automatically, prompt it explicitly: *"Use the `deveco-cli` skill."*

## Commands

| Command | Purpose |
| --- | --- |
| `devecocli create` | Scaffold a new HarmonyOS application project from the bundled template |
| `devecocli build` | Build / package a project or modules into `.hap` / `.hsp` / `.har` / `.app`; `build clean` removes build outputs |
| `devecocli run` | Install (with HSP deps) and launch on a device / emulator; `--skip-build` deploys existing artifacts |
| `devecocli device` | List / inspect connected devices and emulators |
| `devecocli emulator` | Manage local emulators: list / start / stop / create / delete, system images (`image download|remove|list`), and license helpers (`license view` / `license accept`) |
| `devecocli log` | Fetch hilog or crash logs (with level / bundle / keyword / from/to / tail / follow filters) |
| `devecocli docs` | Search and read HarmonyOS documentation from a local docs directory |
| `devecocli init` | Install the bundled `deveco-cli` skill into AI agents; `--mcp` configures the `deveco-mcp` MCP server for ArkTS `.ets` and C/C++ syntax checking |
| `devecocli skills` | List / find / add / remove HMOS skills for AI agents and projects |
| `devecocli serve mcp` | Host the bundled MCP (Model Context Protocol) server over stdio so AI clients (Trae / Claude / …) can call its unified `check` tool for ArkTS `.ets` and C/C++ syntax checking |
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
npm run build                # tsup → dist/cli.js
```

See [`AGENTS.md`](./AGENTS.md) for the architecture overview.

## License

[MIT](./LICENSE)
