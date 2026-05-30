<div align="center">
  <h1>DevEco CLI</h1>
  <p>一个面向 HarmonyOS 应用开发的统一命令行入口。</p>
  <p>
    <a href="https://www.npmjs.com/package/@deveco-test/deveco-cli"><img src="https://img.shields.io/npm/v/@deveco-test/deveco-cli.svg" alt="NPM Version" /></a>
    <a href="https://www.npmjs.com/package/@deveco-test/deveco-cli"><img src="https://img.shields.io/npm/dm/@deveco-test/deveco-cli.svg" alt="NPM Downloads" /></a>
    <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-green.svg" alt="Node.js" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-blue.svg" alt="Platform" />
    <a href="https://developer.huawei.com/consumer/cn/download/"><img src="https://img.shields.io/badge/DevEco%20Studio-%3E%3D6.1.0-orange.svg" alt="DevEco Studio" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License" /></a>
  </p>
</div>

`devecocli` 将 DevEco Studio 工具链统一封装为一个 CLI，内置 `ohpm`、`hvigor`、`hdc`、`emulator`、`hilog`，同时集成 HMOS 技能安装、项目脚手架、本地 HarmonyOS 文档检索和 MCP 服务。

通过单一命令行工具即可完成创建、构建、安装、运行、日志查看、文档检索与 AI Agent 集成等开发流程，无需手动配置 `PATH`、`DEVECO_SDK_HOME` 或 `JAVA_HOME`。

## 为什么用它

- 一条命令完成 `create`、`build`、`run`、`log` 等常见开发流程
- 自动复用 DevEco Studio 自带工具链，减少本地环境配置成本
- 同时支持真机、模拟器、日志诊断和本地文档检索
- 支持给 `opencode`、`cursor`、`trae-cn` 等 AI Agent 注入技能和 MCP 配置
- 面向 CLI 工作流，也适合作为自动化脚本和 Agent 的底层能力

## 快速开始

### 前置要求

- Node.js >= 18
- [DevEco Studio](https://developer.huawei.com/consumer/cn/download/) >= 6.1.0
- 操作系统为 macOS 或 Windows

### 安装

```bash
npm install -g @deveco-test/deveco-cli@latest
```

安装后可以通过以下命令更新到最新版本：

```bash
devecocli update
```

### 最短工作流

```bash
devecocli create --app-name MyApp
cd MyApp
devecocli run
devecocli log --level E
```

### 文档检索

```bash
devecocli docs search List
devecocli docs read harmonyos-guides/application-models/arkts-page-start-overview
```

更多命令和参数可通过 `devecocli --help` 或各子命令的 `--help` 查看。

## AI Agent 集成

`devecocli` 支持接入 `opencode`、`cursor`、`trae-cn` 等 AI Agent。下面以 `opencode` 为例展示最短流程：

```bash
# 1. 给 opencode 安装 deveco-cli 技能
devecocli init --agent opencode

# 2. 给 opencode 在当前 HarmonyOS 项目配置 MCP
devecocli init --mcp --agent opencode --project ./MyApp

# 3. 进入项目并启动 opencode
cd MyApp
opencode
```

进入 Agent 后可以直接描述任务，例如：

- `Build this project in release mode and run it on my emulator`
- `Tail the last error logs from this app`
- `Check for syntax errors in src/main/ets/pages/Index.ets`

## 常用命令

| 命令                        | 用途                                        |
| ------------------------- | ----------------------------------------- |
| `devecocli create`        | 创建新的 HarmonyOS 项目                         |
| `devecocli build`         | 构建项目并产出 `.hap` / `.hsp` / `.har` / `.app` |
| `devecocli run`           | 安装并运行应用                                   |
| `devecocli device list`   | 查看当前连接设备                                  |
| `devecocli emulator list` | 查看本地模拟器实例                                 |
| `devecocli log`           | 查看 `hilog` 或崩溃日志                          |
| `devecocli docs search`   | 搜索本地 HarmonyOS 文档                         |
| `devecocli init`          | 安装内置技能或配置 MCP                             |
| `devecocli skills`        | 管理 HMOS 技能市场中的技能                          |

## 详细使用指南

下面按使用场景保留完整的折叠式参数说明。

<details>
<summary><b>安装与要求</b></summary>

### 前置要求

- **DevEco Studio**：需已安装 DevEco Studio 6.1.0 或更高版本。
  - **Windows**：必须是安装版本，不支持便携版或解压版。默认安装路径为 `C:\Program Files\Huawei\DevEco Studio`。
  - **macOS**：必须安装在 `~/Applications` 或 `/Applications` 目录下，名称中包含 `deveco` 的 `.app` 即可被识别。
- **Node.js**：运行时要求 Node.js 18 或更高版本。

### 安装版本说明

```bash
npm install -g @deveco-test/deveco-cli@latest
```

</details>

<details>
<summary><b>命令概览</b></summary>

```text
Usage: devecocli [options] [command]

HarmonyOS application development command line tool

Options:
  -V, --version          output the version number
  -h, --help             display help for command

Commands:
  build [options]        Build the HarmonyOS project
  run [options]          Build and run the project on a connected device
  update                 Update deveco-cli to the latest version
  device                 Manage connected devices
  emulator               Manage emulator instances
  skills                 Manage HMOS skills
  log [options]          Obtain device application logs
  create [options]       Scaffold a new HarmonyOS application project
  init [options]         Install the deveco-cli skill or configure the deveco-mcp server into AI agents
  serve                  Host bundled auxiliary protocol servers
  docs [options]         Search and read Harmony documentation from local docs directory
  help [command]         display help for command
```

| 类别    | 命令         | 主要子命令                                                                 | 用途                                      |
| ----- | ---------- | --------------------------------------------------------------------- | --------------------------------------- |
| 项目脚手架 | `create`   | -                                                                     | 基于内置模板初始化新工程                            |
| 构建打包  | `build`    | `clean`                                                               | 编译并产出 `.hap` / `.hsp` / `.har` / `.app` |
| 部署运行  | `run`      | -                                                                     | 安装并启动应用                                 |
| 设备管理  | `device`   | `list` / `view`                                                       | 查看当前连接设备与详情                             |
| 模拟器   | `emulator` | `list` / `start` / `stop` / `create` / `delete` / `image` / `license` | 管理本地模拟器实例与系统镜像                          |
| 日志诊断  | `log`      | -                                                                     | 获取 `hilog` 与崩溃日志                        |
| 文档检索  | `docs`     | `search` / `read` / `catalog`                                         | 检索本地 Harmony 文档                         |
| 技能初始化 | `init`     | -                                                                     | 安装内置 `deveco-cli` 技能或配置 `deveco-mcp`    |
| 技能管理  | `skills`   | `list` / `find` / `add` / `remove`                                    | 管理 HMOS 技能市场中的技能                        |
| 辅助服务  | `serve`    | `mcp`                                                                 | 启动内置辅助服务                                |
| 自更新   | `update`   | -                                                                     | 升级到最新版本                                 |

</details>

<details>
<summary><b>创建项目</b></summary>

```bash
devecocli create --project-path ./MyApp --app-name MyApp
```

| 参数                       | 说明                             | 默认值                      |
| ------------------------ | ------------------------------ | ------------------------ |
| `--project-path <path>`  | 项目目录路径                         | `./<app-name>`           |
| `--app-name <name>`      | 应用名称，必填；以字母开头，仅含字母、数字、下划线      | -                        |
| `--bundle-name <bundle>` | Bundle Name，默认根据 `app-name` 生成 | `com.example.<app-name>` |
| `--api-level <level>`    | API 级别（`>=17`），自动探测 SDK 版本     | 无 IDE 时默认 `23`           |

</details>

<details>
<summary><b>构建与运行</b></summary>

```bash
# 构建项目
devecocli build

# 构建指定模块
devecocli build --modules entry library

# 构建 release 版本
devecocli build --build-mode release

# 构建并运行
devecocli run

# 运行到指定设备
devecocli run --device 127.0.0.1:5555

# 清理构建产物并停止 daemon
devecocli build clean
```

### `build` 参数

| 参数                       | 说明                                  | 默认值                  |
| ------------------------ | ----------------------------------- | -------------------- |
| `--product <product>`    | Product 名称；仅指定该参数时构建整个 product      | `default`            |
| `--modules <modules...>` | 指定模块，格式为 `module` 或 `module@target` | 单入口模块时自动检测；多入口时需显式指定 |
| `--build-mode <mode>`    | 构建模式（`debug` / `release` 等）         | `debug`              |

### `run` 参数

| 参数                    | 说明                                    | 默认值                                  |
| --------------------- | ------------------------------------- | ------------------------------------ |
| `--module <module>`   | 要运行的模块，格式为 `module` 或 `module@target` | 单个可运行模块时自动检测                         |
| `--device <device>`   | 目标设备，支持设备名称或序列号                       | 单设备时自动检测                             |
| `--product <product>` | Product 名称                            | `default`                            |
| `--build-mode <mode>` | 构建模式                                  | `debug`                              |
| `--ability <ability>` | 要启动的 Ability                          | 优先 `EntryAbility`，否则取模块中的第一个 Ability |
| `--uninstall`         | 安装前先卸载已有应用                            | -                                    |
| `--skip-build`        | 跳过构建步骤，直接部署已有产物                       | -                                    |

</details>

<details>
<summary><b>设备与模拟器</b></summary>

### 设备管理

```bash
# 列出已连接设备
devecocli device list

# 查看设备详情
devecocli device view
devecocli device view -t 127.0.0.1:5555
```

`device view` 参数：

- `-t, --target <serialOrName>`：目标设备，多设备时必填。

> `run`、`log` 等命令中的 `--device` 同时支持设备名称模糊匹配和序列号精确匹配。

### 模拟器管理

```bash
# 列出所有模拟器
devecocli emulator list

# 启动模拟器
devecocli emulator start HarmonyOS_Phone

# 停止模拟器
devecocli emulator stop HarmonyOS_Phone

# 创建模拟器
devecocli emulator create MyPhone --device-type phone --os-version "HarmonyOS 6.0.1(21)"

# 删除模拟器
devecocli emulator delete MyPhone

# 系统镜像管理
devecocli emulator image list
devecocli emulator image download --device-type phone --os-version "HarmonyOS 6.0.1(21)"
devecocli emulator image remove --device-type phone --os-version "HarmonyOS 6.0.1(21)"

# 许可协议
devecocli emulator license view
devecocli emulator license accept
```

> `emulator start` 和 `emulator image download` 执行前会自动检查许可协议状态，未接受时将提示先运行 `emulator license accept`。

**设备类型：** `phone`、`foldable`、`widefold`、`triplefold`、`tablet`、`2in1`、`2in1 foldable`、`wearable`、`tv`

### `emulator create` 参数

| 参数                       | 说明                                    | 默认值 |
| ------------------------ | ------------------------------------- | --- |
| `<name>`                 | 模拟器名称，仅含字母、空格、数字、下划线                  | -   |
| `--device-type <type>`   | 设备类型，必填                               | -   |
| `--os-version <version>` | 已下载的系统镜像版本，必填，须与 `image list` 中的值完全一致 | -   |
| `--force`                | 覆盖已有实例                                | -   |

### `emulator image list` 参数

| 参数                     | 说明                     | 默认值     |
| ---------------------- | ---------------------- | ------- |
| `--device-type <type>` | 按设备类型筛选                | 全部      |
| `--all`                | 列出所有镜像（已下载 + 未下载）      | 仅已下载    |
| `--format <format>`    | 输出格式（`table` / `json`） | `table` |

### `emulator image download` 参数

| 参数                       | 说明                                   | 默认值 |
| ------------------------ | ------------------------------------ | --- |
| `--device-type <type>`   | 设备类型，必填                              | -   |
| `--os-version <version>` | 系统镜像版本，必填，例如 `"HarmonyOS 6.0.1(21)"` | -   |
| `--force`                | 覆盖已存在的镜像                             | -   |

### `emulator image remove` 参数

| 参数                       | 说明                                  | 默认值 |
| ------------------------ | ----------------------------------- | --- |
| `--device-type <type>`   | 设备类型，必填                             | -   |
| `--os-version <version>` | 系统镜像版本，必填，支持镜像标签和 `softwareVersion` | -   |

</details>

<details>
<summary><b>日志与文档检索</b></summary>

### 日志诊断

```bash
# 获取日志
devecocli log

# 按级别过滤
devecocli log --level E

# 按应用过滤
devecocli log --bundle-name com.example.app

# 崩溃日志
devecocli log --crash

# 实时日志
devecocli log --follow

# 时间窗口
devecocli log --from 5m --tail 100
```

| 参数                            | 说明                                | 默认值      |
| ----------------------------- | --------------------------------- | -------- |
| `--device <device>`           | 目标设备，支持设备名称或序列号                   | 单设备时自动检测 |
| `--crash`                     | 崩溃日志模式                            | -        |
| `--level <level>`             | 日志级别（`D` / `I` / `W` / `E` / `F`） | -        |
| `--bundle-name <bundle-name>` | 按 Bundle Name 过滤                  | -        |
| `--keyword <keyword>`         | 关键词过滤                             | -        |
| `--tail <num>`                | 只显示最新 N 行                         | -        |
| `--from <start>`              | 起始偏移（如 `30s`、`5m`、`2.5m`）         | -        |
| `--to <end>`                  | 结束偏移（格式同 `--from`）                | -        |
| `--follow`                    | 实时跟随，不可与 `--to` 同时使用              | -        |

### 本地文档检索

```bash
# 搜索文档
devecocli docs search ArkTS Row layout

# 指定目录搜索
devecocli docs search @State @Prop --catalog harmonyos-guides --limit 10

# 阅读文档
devecocli docs read harmonyos-guides/application-models/arkts-page-start-overview

# 列出所有目录
devecocli docs catalog
```

参数说明：

- `search <keywords...>`：关键词搜索，支持多个关键词，采用 OR 逻辑，最多 10 个关键词。
- `--catalog <name>`：指定目录，默认 `all`。
- `--format <default|json>`：输出格式，默认 `default`。
- `--limit <n>`：最大结果数，默认 `20`。
- `read <documentId>`：根据文档 ID 阅读完整内容。
- `catalog`：列出所有可用目录。

</details>

<details>
<summary><b>AI Agent、技能与 MCP</b></summary>

### 什么时候用 `init`、`skills`、`serve`

- `init`：推荐新用户使用，用于安装内置 `deveco-cli` 技能或配置 `deveco-mcp`
- `skills`：用于管理 HMOS 技能市场中的技能
- `serve`：用于启动内置辅助服务，当前仅有 `serve mcp`

### `init`

```bash
# 安装技能到所有检测到的 AI Agent
devecocli init

# 仅安装技能到指定 Agent
devecocli init --skill --agent opencode

# 已安装过时强制更新技能
devecocli init -f

# 配置全局 MCP 服务器
devecocli init --mcp

# 为指定 Agent 配置项目级 MCP 服务器
devecocli init --mcp --agent opencode --project ./my-app
```

| 参数                 | 说明                             | 默认值           |
| ------------------ | ------------------------------ | ------------- |
| `--agent <agents>` | 目标 Agent（逗号分隔）                 | 所有已检测到的 Agent |
| `--project <path>` | 安装到项目目录                        | -             |
| `--path <path>`    | 直接安装到指定路径                      | -             |
| `--skill`          | 仅安装内置 `deveco-cli` 技能          | 默认行为          |
| `--mcp`            | 仅配置 `deveco-mcp` MCP 服务器，不安装技能 | -             |
| `-f, --force`      | 强制覆盖已有配置                       | -             |

### `skills`

```bash
# 列出技能列表
devecocli skills list --long

# 搜索技能
devecocli skills find harmony

# 安装所有技能
devecocli skills add --all

# 安装指定技能
devecocli skills add --skill deveco-cli --agent cursor

# 移除技能
devecocli skills remove --skill deveco-cli
```

### `serve mcp`

```bash
devecocli serve mcp
```

`serve` 当前仅提供 `mcp` 子命令，用于以本地 `stdio` 模式启动 MCP 服务器，为 ArkTS 和 C/C++ 提供语法检查能力。

</details>

<details>
<summary><b>调试与常见问题</b></summary>

### 查看底层命令调用

如需打印底层 `ohpm`、`hvigor`、`hdc`、`emulator` 等实际执行命令，可设置：

```bash
DEVECO_CLI_DEBUG=1 devecocli build
```

### 常见问题

**Q: CLI 报错找不到 DevEco Studio？**

A: 确保已安装 DevEco Studio 6.1.0 或更高版本。CLI 会按以下顺序探测：

- **Windows**：注册表 -> `C:\Program Files\Huawei\DevEco Studio`
- **macOS**：`~/Applications` -> `/Applications`

**Q: 多设备环境下如何选择目标设备？**

A: 使用 `--device` 指定设备名或序列号：

```bash
devecocli run --device "My Phone"
devecocli run --device 127.0.0.1:5555
```

**Q: 模拟器启动或下载镜像时被许可协议阻塞？**

A: 需要在本地交互终端运行：

```bash
devecocli emulator license accept
```

确认 `y` 或 `yes` 后重试。AI Agent 无法替用户完成该交互步骤。

**Q: 安装应用时提示** **`install sign info inconsistent`？**

A: 使用 `--uninstall` 先卸载旧版本：

```bash
devecocli run --uninstall
```

</details>

## 开发

```bash
npm install
npm run dev
npm start -- <command>
npm run lint
npm run format
npm run build
```

- 架构与目录说明见 [`AGENTS.md`](./AGENTS.md)
- 如需参与维护，建议先阅读 `AGENTS.md` 中的约定与架构说明

## 许可证

[MIT](./LICENSE)
