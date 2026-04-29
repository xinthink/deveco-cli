# deveco-cli

HarmonyOS application development command line tool.

## Features

### build

Automates HarmonyOS project builds using `ohpm` and `hvigor`.

#### Usage

```text
Usage: deveco build [options]

Build HarmonyOS project

Options:
  --product <product>      Product to build
  --modules <modules...>   Modules to build. Format: module or module@target
  --buildMode <buildMode>  Build mode (e.g., debug, release)
  -h, --help               display help for command
```

#### Example

```bash
deveco build                                   # Auto-detects and builds the entry module
deveco build --modules entry feature@default   # Build specific modules (with optional targets)
deveco build --product default                 # Build specific product (mutually exclusive with --modules)
deveco build --buildMode release               # Specify build mode (debug/release)
```

### update

Update the CLI tool to the latest version.

#### Usage

```text
Usage: deveco update

Update the CLI tool to the latest version

Options:
  -h, --help  display help for command
```

#### Example

```bash
deveco update  # Updates the CLI tool globally via npm
```

