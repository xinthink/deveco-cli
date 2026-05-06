# Agents.md

This file provides guidance to AI coding assistants when working with code in this repository.

## Project Overview

**deveco-cli** is a HarmonyOS application development command line tool. It provides a CLI wrapper around DevEco Studio's build tools (ohpm, hvigor) to enable command-line building of HarmonyOS projects.

## Commonly Used Commands

```bash
# Build the project
npm run build


# Run the CLI directly
npm start

# Lint code
npm run lint

# Fix lint issues
npm run lint:fix

# Format code
npm run format
```

## Architecture

### Directory Structure

```
src/
├── cli.ts              # Entry point, defines CLI commands
├── commands/
│   ├── build.ts        # Build command implementation
│   └── update.ts       # Update CLI tool command
└── utils/
    ├── project.ts      # Project discovery and profile parsing
    ├── tool-provider.ts # DevEco Studio toolchain detection
    ├── ohpm-adapter.ts # Wrapper for ohpm commands
    └── hvigor-adapter.ts # Wrapper for hvigor commands
```

### Key Components

1. **CLI Entry** (`src/cli.ts`) - Uses Commander.js to define commands:
   - `build`: Build HarmonyOS project
   - `update`: Update the CLI tool to latest version
2. **Build Command** (`src/commands/build.ts`) - Main build workflow:
   - Modularized into single-responsibility functions (`validateOptions`, `determineModulesToBuild`, `processModuleTasks`, `executeBuildSteps`).
   - Discovers project using `Project.discover()`
   - Finds toolchain via `ToolProvider.new()`
   - Uses `OhpmAdapter` and `HvigorAdapter` for tool execution
   - Build steps: `ohpm install --all` → `hvigor --sync` → `hvigor assembleHap/assembleHsp/assembleHar`
   - Supports options: `--product`, `--modules`, `--buildMode`
3. **Update Command** (`src/commands/update.ts`) - CLI self-update:
4. <br />
   - Runs `npm install -g &lt;package-name&gt;@latest`
   - Auto-detects package name from package.json
5. **Ohpm Adapter** (`src/utils/ohpm-adapter.ts`) - Wrapper for ohpm:
   - `installAll()`: Runs `ohpm install --all`
6. **Hvigor Adapter** (`src/utils/hvigor-adapter.ts`) - Wrapper for hvigor:
   - `sync()`: Runs `hvigor --sync`
   - `buildProduct()`: Runs `hvigor assembleApp`
   - `buildModules()`: Runs module-specific hvigor tasks
   - Sets up Java path and DEVECO\_SDK\_HOME environment
7. **Project Utility** (`src/utils/project.ts`) - Parses HarmonyOS project structure:
   - Discovers `build-profile.json5` in parent directories
   - Parses JSON5 project profiles
   - Validates products, modules, and targets
8. **Tool Provider** (`src/utils/tool-provider.ts`) - Locates DevEco Studio installation:
   - Windows: Registry lookup + default paths
   - macOS: /Applications + \~/Applications
   - Resolves node, ohpm, hvigor, java, and SDK paths

## Technology Stack

- **Language**: TypeScript
- **Module System**: ES Modules (type: "module")
- **Build Tool**: tsup (bundles to ESM for Node.js 18+)
- **CLI Framework**: Commander.js
- **Key Dependencies**:
  - `execa`: Process execution
  - `json5`: JSON5 parsing for build profiles
  - `regedit`: Windows registry access
  - `fs-extra`: Enhanced file system operations
  - `colorette`: Terminal color output

## Development Notes

- Node.js >= 18 required
- Output builds to `dist/cli.js` (bin: `deveco`)
- Source files use `.js` extension in imports (ESM requirement)
- Project configuration uses JSON5 format (`build-profile.json5`)

