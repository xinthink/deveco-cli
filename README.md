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

### emulator

Emulator management commands (list, start, stop).

#### Usage

```text
Usage: deveco emulator [options]

Emulator management commands

Options:
  --list          List all emulator instances
  --start         Start an emulator
  --stop          Stop an emulator
  --name <name>   Emulator instance name
  -h, --help      display help for command
```

#### Example

```bash
deveco emulator --list                        # List all emulator instances
deveco emulator --start --name MyEmulator     # Start an emulator by name
deveco emulator --stop --name MyEmulator      # Stop an emulator by name
```

### device

Device management commands (list, info, install, uninstall).

#### Usage

```text
Usage: deveco device [options]

Device management commands

Options:
  -t, --target <serial>           Target device serial number
  --list                          List all connected devices
  --info                          Show detailed device information
  --install <packagePaths...>     Install application packages (.hap, .hsp, .app)
                                  Supports multiple packages for dependency-first installation
  --uninstall <bundleName>        Uninstall an application by bundle name
  -b, --bundle <bundleName>       Bundle name for starting app after install
  -a, --ability <abilityName>     Ability name for starting app after install
  -h, --help                      display help for command
```

#### Example

```bash
deveco device --list                                                       # List all connected devices
deveco device --info                                                       # Show info of the single device
deveco device --info -t <serial>                                           # Show info of a specific device
deveco device --install ./entry-default-signed.hap                         # Install app to the single device
deveco device --install ./entry-default-signed.hap -t <serial>             # Install app to a specific device
deveco device --install ./lib.hsp ./entry-default-signed.hap               # Multi-package install (dependencies first)
deveco device --install ./entry.hap -b com.example.entry -a EntryAbility   # Install and auto-start app
deveco device --uninstall com.example.entry                                # Uninstall app by bundle name
deveco device --uninstall com.example.entry -t <serial>                    # Uninstall from a specific device
```

### log

Log management commands (list, info, install, uninstall).

#### Usage

```text
Usage: deveco log [options]

Obtain device application logs

Options:
  --crash               Only obtain the crash log
  --target <device>     Target device ID
  --level <level>       Log level filtering: D, I, W, E, F
  --bundle-name <name>  Application package name filtering
  --keyword <pattern>   Keyword filtering
  -h, --help            display help for command
```

#### Example

```bash
deveco log                                  					# Displaying common logs
deveco log --crash                          					# Displaying crash logs
deveco log --target 127.0.0.1:5555          					# Filtering and displaying common logs of the device whose ID is 127.0.0.1:5555
deveco log --level I                        					# Filtering and displaying logs whose log level is I 
deveco log --bundle-name com.example.myapplication    # Filtering and displaying logs whose application package name is "com.example.myapplication" 
deveco log --keyword err:1002               					# Filtering and displaying logs with the keyword is "err:1002"
```