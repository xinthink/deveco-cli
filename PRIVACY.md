# 隐私说明

本文件说明 `deveco-cli` 内置的遥测（打点）功能采集哪些数据、如何存储与上报，以及如何关闭。

## 1. 遥测默认开启

`deveco-cli` 默认开启匿名遥测，用于改进产品体验（如统计命令使用频率、构建耗时、失败率等）。遥测不影响任何业务功能的执行：打点失败、上报失败均不会阻塞或改变命令行为。

## 2. 采集内容

### 2.1 事件类别

| 事件 | 触发场景 | 采集的业务字段（event_detail） |
|---|---|---|
| 命令执行 | `devecocli` 各子命令（build / run / device / emulator / skills / docs / update / create / auth 等） | 命令名、使用的选项（仅 flag 名称，不含参数值）、耗时、成功/失败、错误码、部分命令的内存统计（如构建内存） |
| MCP 工具调用 | `devecocli serve mcp` 下的工具调用（check / hover / definition / references 等） | 工具名、方向（incoming/outgoing）、文件扩展名、CLI 与语言服务进程内存、成功/失败、错误码 |
| 技能操作 | `devecocli skills add / list / find / remove` | 子操作名、使用的选项（仅 flag 名称）、下载数据量、安装/移除成功数、失败原因 |
| 文档检索 | `devecocli docs search / read / catalog` | 搜索关键词、目录名、文档 ID |
| 语法检查 | `devecocli check lint` / `check compat` | 命令选项（仅 flag 名称）、耗时、成功/失败、错误码、内存统计 |

### 2.2 每条事件的公共字段

- `uid`：设备标识。优先由本机网卡 MAC 地址做 SHA-256 单向哈希派生（不可逆，不包含 MAC 原文）；无可用网卡时回退为随机 UUID。
- `session_id`：本次进程会话的随机 ID（不落盘）。
- `trace_uuid`：每条事件的随机 ID。
- 环境信息：操作系统名称与架构、CLI 版本、DevEco Studio 版本、CLT 版本、Node.js 版本。
- 耗时、成功/失败、错误码。

## 3. 不采集的内容

- **不采集**：源码、文件内容、工程内数据、命令输出、终端输入。
- **不采集**：DevEco 账号、登录凭据、token、Cookie 等敏感信息。
- **不采集**：操作系统级硬件标识（Windows `MachineGuid`、macOS `IOPlatformUUID`、Linux `machine-id` 等）。
- 命令选项仅记录 flag 名称（如 `--module`），不记录 flag 对应的参数值。

## 4. 本地存储与加密

- 数据目录：`<数据根目录>/TraceLogData/`。数据根目录默认 `~/.local/share/deveco-cli/`，可通过环境变量 `DEVECO_CLI_DATA_DIR` 覆盖。
- 事件按天分文件落盘（`telemetry-YYYY-MM-DD.txt`），文件使用 **AES-256-GCM 加密**存储，密钥由设备标识派生、不落盘；上传前在内存中解密。
- 上报失败的事件会加密归档到 `TraceLogData/failed/`，不会自动重传。
- 删除数据：直接删除 `TraceLogData` 目录即可清空全部打点数据。

## 5. 上报

- 本地存在待上报事件且距首条事件超过 **5 分钟**时，通过 HTTPS 上报到 `https://cn.devecostudio.huawei.com/codeGenie/cli/trace/upload`。
- 上报内容为上述事件数据，不含任何本地文件内容。

## 6. 如何关闭

设置环境变量并重启终端会话即可完全关闭遥测：

```bash
# Windows (PowerShell)
$env:DEVECO_CLI_DISABLE_TELEMETRY = "1"

# macOS / Linux
export DEVECO_CLI_DISABLE_TELEMETRY=1
```

关闭后：

- 不再采集任何事件，不创建新的打点文件，不上传。
- 已有打点数据不会自动删除（如需删除，见第 4 节）。
- 业务功能不受任何影响。

## 7. 相关环境变量

| 环境变量 | 作用 |
|---|---|
| `DEVECO_CLI_DISABLE_TELEMETRY=1` | 关闭遥测（采集与上报） |
| `DEVECO_CLI_DATA_DIR` | 覆盖数据根目录（含打点数据目录） |
