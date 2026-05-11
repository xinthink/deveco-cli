# deveco-cli

> HarmonyOS application development command line tool.

`deveco` is a unified CLI wrapper around the DevEco Studio toolchain — `ohpm`, `hvigor`, `hdc`, `emulator`, `hilog` — plus Huawei Developer login, HarmonyOS knowledge search, the HMOS skills installer, and a project-scaffolding template. Drive the full HarmonyOS workflow (create → build → install → run → log → query → install AI skills) from one binary, with no `PATH` / `DEVECO_SDK_HOME` / `JAVA_HOME` setup.

## Quick Start

**Prerequisites:** Node.js >= 18, DevEco Studio installed (Windows or macOS).

> Not published yet — until then, build from source (see [Development](#development)) and run `node ./dist/cli.js`. After release, self-update via `deveco update`.

End-to-end on the command line:

```bash
deveco create --app-name MyApp   # scaffold (default path: ./MyApp)
cd MyApp
deveco build                                            # package .hap
deveco run                                              # install + launch
deveco log --level E                                    # tail logs
```

Run any command with `--help` for full options. Set `DEVECO_CLI_DEBUG=1` to print the raw underlying tool invocations.

### Drive deveco from an AI agent (opencode example)

Instead of typing the commands above by hand, let an agent (`opencode`, `claude`, `cursor`, …) drive `deveco` for you. The flow below uses [opencode](https://opencode.ai/):

1. **Teach the agent how `deveco` works** — install the bundled `deveco-cli` skill into opencode:

   ```bash
   deveco init --agent opencode
   # writes the skill to ~/.config/opencode/skills/deveco-cli/
   ```

   (Run `deveco init` with no flags to install into every detected agent at once.)

2. **Open a project and start opencode**:

   ```bash
   cd MyApp        # any HarmonyOS project (with build-profile.json5 / oh-package.json5)
   opencode
   ```

3. **Ask in natural language** — opencode auto-loads the `deveco-cli` skill and turns prompts like the following into the right `deveco` invocations:

   - `Scaffold a new HarmonyOS app called Demo at ./Demo and build it`
   - `Build this project in release mode and run it on my emulator`
   - `Tail the last error logs from this app`
   - `Look up the ArkTS API for showing a Toast`

If the agent doesn't pick up the skill automatically, prompt it explicitly: *"Use the `deveco-cli` skill."*

## Commands

| Command | Purpose |
| --- | --- |
| `deveco create` | Scaffold a new HarmonyOS application project from the bundled template |
| `deveco build` | Build / package a project or modules into `.hap` / `.hsp` / `.har` / `.app` |
| `deveco run` | Install (with HSP deps) and launch on a device / emulator |
| `deveco device` | List / inspect / install / uninstall on connected devices |
| `deveco emulator` | List, start (one or many), and stop local emulators — quote instance names that contain spaces |
| `deveco log` | Fetch hilog or crash logs (with level / bundle / keyword / follow filters) |
| `deveco knowledge` | Search the HarmonyOS / ArkTS knowledge base (requires `deveco login`) |
| `deveco init` | Install the bundled `deveco-cli` skill into your AI agents (`claude`, `cursor`, …) so they learn how to drive `deveco` |
| `deveco skills` | List / find / add / remove HMOS skills for AI agents and projects |
| `deveco login` / `logout` | Sign in / out of a Huawei Developer account |
| `deveco update` | Update the CLI itself (`npm install -g deveco-cli@latest`) |

Run `deveco <cmd> --help` for full options, or see [`SKILL.md`](./SKILL.md) for the detailed reference (also consumed by AI agents).

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
