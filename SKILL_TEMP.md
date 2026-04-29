---
name: "deveco-cli"
description: "Use 'deveco' to build and package HarmonyOS projects (build-profile.json5 or oh-package.json5)."
---

# DevEco CLI Assistant

This Skill provides guidance on using the `deveco` command-line tool. **It is important to emphasize that the core command of this tool is `deveco`. HarmonyOS projects can use this command to perform routine compilation, packaging, and other capabilities.** It wraps the underlying build toolchain of DevEco Studio (such as `ohpm`, `hvigor`), allowing developers to conveniently build and manage HarmonyOS projects in a command-line environment. **Once the `deveco` command is available, you should avoid using commands like `hvigor`, `ohpm`, and `hdc` as much as possible.**

## Core Features & Commands

**General Help Information (`deveco --help`):**
<!-- EXEC_START: node ./dist/cli.js --help -->
```text
Usage: deveco [options] [command]

HarmonyOS application development command line tool

Options:
  -V, --version    output the version number
  -h, --help       display help for command

Commands:
  build [options]  Build HarmonyOS project
  update           Update the CLI tool to the latest version
  help [command]   display help for command
```
<!-- EXEC_END -->

### 1. Build Project (`deveco build`)
Used to compile and build HarmonyOS projects. This command automatically parses project configurations (`build-profile.json5`), locates the DevEco Studio toolchain, and sequentially executes dependency installation and project building.

**Build Command Help Information (`deveco build --help`):**
<!-- EXEC_START: node ./dist/cli.js build --help -->
```text
Usage: deveco build [options]

Build HarmonyOS project

Options:
  --product <product>      Product to build
  --modules <modules...>   Modules to build. Format: module or module@target
  --buildMode <buildMode>  Build mode (e.g., debug, release)
  -h, --help               display help for command
```
<!-- EXEC_END -->

#### **Usage Examples:**
**Build Modules (.hsp/.har/.hap)**
- **Build the single module or single entry module**: `deveco build`
- **Build Specific Modules**: `deveco build --modules <module1> <module2>@<target>`
- **Build Specific Mode**: `deveco build --buildMode <mode>` (Supports debug, release, or custom values defined in build-profile.json5)

**Build Products (.app)**
- **Build Specific Product**: `deveco build --product <product-name>`

### 2. Update Tool (`deveco update`)
Used to update the `deveco` CLI tool itself to the latest version.

**Usage Examples:**
- **Update Tool**: `deveco update`