/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { HilogOptions } from './config.js';
import { ToolProvider } from './tool-provider.js';
import { DeviceManager } from '../service/device-manager.js';
import { cyan } from 'colorette';
import { CommonUtils } from './common-utils.js';
import { debugLog } from './logger.js';
import {
  runStreamingCommand,
  type StreamSource,
  type StreamCommandHandlers,
} from './cmd.js';
import {
  classifyHdcOutput,
  runHdcWithRetry,
  type HdcCommandResult,
} from './hdc-param.js';

function detectHdcSentinel(
  result: HdcCommandResult,
  context: string
): Error | null {
  // 命令成功时不要把 stdout 当 fatal 探针 —— hilog / hidumper 的正常输出
  // 经常包含 "not found" / "fail" 等子串，会被宽匹配误判成致命错误。
  if (result.exitCode === 0) {
    return null;
  }
  const probe = result.stderr || result.stdout;
  const cls = classifyHdcOutput(probe);
  if (cls === 'transient') {
    return new Error(
      `${context}: Device communication channel unavailabel. Retry in a few seconds.`
    );
  }
  if (cls === 'fatal') {
    return new Error(`${context}: ${probe.trim()}`);
  }
  return null;
}

interface ConnectedDevice {
  serial: string;
  name: string;
}

export interface HilogDataHandler {
  (lines: string[], source: StreamSource): void;
}

export interface HilogErrorHandler {
  (error: Error): void;
}

export interface HilogCloseHandler {
  (code: number | null): void;
}

const HILOG_RETRY_DELAYS_MS = [800, 1500, 2500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HilogAdapter {
  private toolProvider: ToolProvider;
  private deviceManager: DeviceManager;

  constructor(toolProvider: ToolProvider) {
    this.toolProvider = toolProvider;
    this.deviceManager = DeviceManager.from(toolProvider);
  }

  private createFollowLineHandler(options: HilogOptions): HilogDataHandler {
    return (lines, source) => {
      const visibleLines = options.keyword
        ? lines.filter((line) => line.includes(options.keyword as string))
        : lines;
      if (source === 'stderr') {
        return;
      }
      for (const line of visibleLines) {
        console.log(line);
      }
    };
  }

  private findDeviceByArg(
    connectedDevices: ConnectedDevice[],
    deviceArg: string
  ): ConnectedDevice | undefined {
    return connectedDevices.find(
      (d) => d.serial === deviceArg || d.name === deviceArg
    );
  }

  private formatConnectedDeviceList(
    connectedDevices: ConnectedDevice[]
  ): string {
    return connectedDevices
      .map((d) => `  - ${d.name} (${d.serial})`)
      .join('\n');
  }

  private async loadConnectedDevicesByName(): Promise<
    ConnectedDevice[] | undefined
  > {
    const connectedDevices = await this.getConnectedDevices();
    if (!connectedDevices) {
      return undefined;
    }
    return connectedDevices;
  }

  /**
   * 获取选择的设备
   * @param deviceArg 用户传入的 --device 参数（可以是设备 name 或 serial）
   */
  async selectDevice(deviceArg?: string): Promise<string | undefined> {
    const serials = await this.getConnectedDeviceSerials();
    if (!serials) {
      return undefined;
    }

    if (!deviceArg && serials.length === 1) {
      const serial = serials[0];
      debugLog(cyan(`Using device serial: ${serial}`));
      return serial;
    }

    if (deviceArg && serials.includes(deviceArg)) {
      debugLog(cyan(`Using device serial: ${deviceArg}`));
      return deviceArg;
    }

    const connectedDevices = await this.loadConnectedDevicesByName();
    if (!connectedDevices) {
      return undefined;
    }

    if (deviceArg) {
      const found = this.findDeviceByArg(connectedDevices, deviceArg);
      if (found) {
        debugLog(cyan(`Using device: ${found.name} (${found.serial})`));
        return found.serial;
      }
      const list = this.formatConnectedDeviceList(connectedDevices);
      throw new Error(
        `Device '${deviceArg}' not found.\nAvailable devices:\n${list}`
      );
    }

    if (connectedDevices.length === 1) {
      const device = connectedDevices[0];
      debugLog(cyan(`Using device: ${device.name} (${device.serial})`));
      return device.serial;
    }

    throw new Error(
      'Multiple devices found. Specify a target device using `--device <name>` or `--device <serial>`.\nAvailable devices:\n' +
        this.formatConnectedDeviceList(connectedDevices)
    );
  }

  /**
   * 获取已连接设备 serial 列表（快速路径，不查询设备名）
   */
  private async getConnectedDeviceSerials(): Promise<string[] | null> {
    const devices = await this.deviceManager.listDevices();
    if (devices.length === 0) {
      throw new Error(
        'No active devices found. Start an emulator or connect a physical device.'
      );
    }
    return devices.map((d) => d.serial);
  }

  /**
   * 获取已连接的设备列表（包含设备名）
   */
  private async getConnectedDevices(): Promise<ConnectedDevice[] | null> {
    const devices = await this.deviceManager.listDevicesWithName();

    if (devices.length === 0) {
      throw new Error(
        'No active devices found. Start an emulator or connect a physical device.'
      );
    }
    return devices;
  }

  /**
   * 通过应用包名获取进程 ID (PID)
   * @param hdcPath - hdc 工具路径
   * @param deviceId - 设备 ID
   * @param bundleName - 应用包名
   * @returns 进程 ID，如果未找到则返回 null
   */
  async getPidForBundle(
    hdcPath: string,
    deviceId: string,
    bundleName: string
  ): Promise<string | null> {
    debugLog(`Retrieving PID for bundle ${bundleName}`);
    CommonUtils.assertBundleName(bundleName);

    const result = await runHdcWithRetry(hdcPath, [
      '-t',
      deviceId,
      'shell',
      'pidof',
      bundleName,
    ]);
    const sentinel = detectHdcSentinel(result, 'Failed to look up PID');
    if (sentinel) {
      throw sentinel;
    }

    if (result.exitCode === 0 && result.stdout.trim()) {
      const pidStr = result.stdout.trim();
      const firstPid = pidStr.split(/\s+/)[0] || pidStr;
      debugLog(`Found PID for ${bundleName}: ${firstPid}`);
      return firstPid;
    }

    debugLog(`No PID found for bundle: ${bundleName}`);
    return null;
  }

  /**
   * 调整 hilog 日志缓冲区大小
   * @param hdcPath - hdc 工具路径
   * @param deviceId - 设备 ID
   * @param size - 缓冲区大小（如 "4M", "16M" 等）
   */
  async resizeHilogBuffer(
    hdcPath: string,
    deviceId: string,
    size: string
  ): Promise<void> {
    debugLog(`Setting hilog buffer size to: ${size}`);
    const result = await runHdcWithRetry(hdcPath, [
      '-t',
      deviceId,
      'shell',
      'hilog',
      '-G',
      size,
    ]);
    const sentinel = detectHdcSentinel(result, 'Failed to resize hilog buffer');
    if (sentinel) {
      throw sentinel;
    }

    if (result.exitCode !== 0) {
      console.error(
        `Failed to resize hilog buffer: ${result.stderr || result.stdout}`
      );
    }
  }

  /**
   * 构建 hilog 命令参数数组
   * @param hdcPath - hdc 工具路径
   * @param deviceId - 设备 ID
   * @param options - 日志过滤选项
   * @param pid - 进程 ID（可选）
   * @returns 命令和参数数组 [command, ...args]
   */
  buildHilogCommand(
    hdcPath: string,
    deviceId: string,
    options: HilogOptions,
    pid?: string | undefined
  ): [string, string[]] {
    const shellCmd = this.buildHilogShellCommand(options, pid);
    const args = ['-t', deviceId, 'shell', shellCmd];
    return [hdcPath, args];
  }

  private buildHilogShellCommand(
    options: HilogOptions,
    pid?: string | undefined
  ): string {
    const parts: string[] = ['hilog'];

    if (!options.isFollow) {
      parts.push('-x');
    }

    if (options.tag) {
      CommonUtils.assertHilogToken(options.tag, 'tag');
      parts.push('-T', options.tag);
    }

    if (options.level) {
      CommonUtils.assertHilogLevel(options.level);
      parts.push('-L', options.level);
    }

    if (options.domain) {
      CommonUtils.assertHilogToken(options.domain, 'domain');
      parts.push('-D', options.domain);
    }

    if (pid) {
      parts.push('-P', pid);
    }

    if (options.keyword) {
      CommonUtils.assertHilogKeyword(options.keyword);
      parts.push('-e', CommonUtils.quotePosixShellArg(options.keyword));
    }

    return parts.join(' ');
  }

  /**
   * 实时跟随日志输出（不缓存 stdout/stderr，避免 maxBuffer 溢出）
   */
  public async followHilog(
    command: string,
    args: string[],
    onData: HilogDataHandler,
    onError: HilogErrorHandler,
    onClose: HilogCloseHandler
  ): Promise<HdcCommandResult> {
    const handlers: StreamCommandHandlers = { onData, onError, onClose };
    const result = await runStreamingCommand(command, args, handlers);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    };
  }

  private async runHilogWithSpawnRetry(
    command: string,
    args: string[],
    onData: HilogDataHandler,
    onError: HilogErrorHandler,
    onClose: HilogCloseHandler
  ): Promise<HdcCommandResult> {
    const attempts = 1 + HILOG_RETRY_DELAYS_MS.length;
    let last: HdcCommandResult = { stdout: '', stderr: '', exitCode: -1 };
    for (let attempt = 0; attempt < attempts; attempt++) {
      last = await this.followHilog(command, args, onData, onError, onClose);
      const probe =
        last.exitCode === 0 ? last.stdout : last.stderr || last.stdout;
      if (classifyHdcOutput(probe) !== 'transient') {
        return last;
      }
      if (attempt >= attempts - 1) {
        return last;
      }
      debugLog(
        `hdc transient failure on \`${args.join(' ')}\`: retrying in ${HILOG_RETRY_DELAYS_MS[attempt]}ms`
      );
      await sleep(HILOG_RETRY_DELAYS_MS[attempt]);
    }
    return last;
  }

  private async printTailSnapshotIfNeeded(
    hdcPath: string,
    deviceId: string,
    options: HilogOptions,
    pid: string
  ): Promise<void> {
    if (!options.tail && !options.fromSeconds && !options.toSeconds) {
      return;
    }

    const snapshotOptions = { ...options, isFollow: false };
    const [, snapshotArgs] = this.buildHilogCommand(
      hdcPath,
      deviceId,
      snapshotOptions,
      pid
    );
    const snapshotResult = await runHdcWithRetry(hdcPath, snapshotArgs);
    const sentinel = detectHdcSentinel(snapshotResult, 'Failed to get hilog');
    if (sentinel) {
      throw sentinel;
    }
    if (snapshotResult.exitCode !== 0 && snapshotResult.stderr) {
      throw new Error(`Failed to get hilog: ${snapshotResult.stderr}`);
    }

    let snapshotLogs = CommonUtils.filterLogsByRelativeWindow(
      snapshotResult.stdout || snapshotResult.stderr,
      options.fromSeconds,
      options.toSeconds
    );
    snapshotLogs = CommonUtils.getLastLines(snapshotLogs, options.tail);
    if (snapshotLogs.trim()) {
      console.log(snapshotLogs);
    }
  }

  private async getHilogOnce(
    hdcPath: string,
    deviceId: string,
    options: HilogOptions,
    pid: string
  ): Promise<string> {
    const [command, args] = this.buildHilogCommand(
      hdcPath,
      deviceId,
      options,
      pid
    );
    debugLog(`Ready to run hilog command: ${command} ${args.join(' ')}`);

    const result = await this.runHilogWithSpawnRetry(
      command,
      args,
      () => {
        // 一次性读取模式在结果返回后统一处理，不在流回调中输出
      },
      (error) => {
        debugLog(`Callback triggered when an error occurs during a single hilog streaming read: ${error.message}`);
      },
      () => {
        // 非 follow 场景下无需额外处理 close，等待 Promise 结束即可
      }
    );
    const sentinel = detectHdcSentinel(result, 'Failed to get hilog');
    if (sentinel) {
      throw sentinel;
    }
    if (result.exitCode !== 0 && result.stderr) {
      throw new Error(`Failed to get hilog: ${result.stderr}`);
    }

    const collectedOutput = result.stdout || result.stderr;
    let logs = CommonUtils.filterLogsByRelativeWindow(
      collectedOutput,
      options.fromSeconds,
      options.toSeconds
    );
    logs = CommonUtils.getLastLines(logs, options.tail);
    return logs;
  }

  private async runHilogFollow(
    hdcPath: string,
    deviceId: string,
    options: HilogOptions,
    pid: string
  ): Promise<string> {
    await this.printTailSnapshotIfNeeded(hdcPath, deviceId, options, pid);

    const [command, args] = this.buildHilogCommand(
      hdcPath,
      deviceId,
      options,
      pid
    );
    debugLog(
      `Ready to run hilog command which contain \`follow\` and \`tail\`: ${command} ${args.join(' ')}`
    );
    const result = await this.runHilogWithSpawnRetry(
      command,
      args,
      this.createFollowLineHandler(options),
      (error) => {
        console.error(error.message);
      },
      () => {
        // close 回调预留给外部处理，这里保持安静退出
      }
    );
    const sentinel = detectHdcSentinel(result, 'Failed to follow hilog');
    if (sentinel) {
      throw sentinel;
    }
    if (result.exitCode !== 0 && result.stderr) {
      throw new Error(`Failed to follow hilog: ${result.stderr}`);
    }
    return '';
  }

  /**
   * 获取设备的普通日志
   * @param deviceId - 设备 ID
   * @param bundleName - 应用包名（可选）
   * @returns 普通日志内容
   * @throws 如果获取失败则抛出错误
   */
  async getHilog(deviceId: string, options: HilogOptions): Promise<string> {
    const hdcPath = this.toolProvider.hdcPath;
    // 如果提供了 bundle_name，获取进程 ID
    const pid = options.bundleName
      ? await this.getPidForBundle(hdcPath, deviceId, options.bundleName)
      : undefined;

    if (options.bundleName && !pid) {
      throw new Error(
        `No running process found for bundle '${options.bundleName}'. Ensure the app is launched on the device before fetching logs.`
      );
    }

    // 如果提供了 log_size，调整缓冲区大小
    if (options.logSize) {
      await this.resizeHilogBuffer(hdcPath, deviceId, options.logSize);
    }

    // 处理实时跟随日志（follow）
    if (options.isFollow) {
      return await this.runHilogFollow(hdcPath, deviceId, options, pid || '');
    }

    // 处理一次性拉取日志（非follow）
    return await this.getHilogOnce(hdcPath, deviceId, options, pid || '');
  }

  /**
   * 获取设备的崩溃日志工具路径
   * @param deviceId - 设备 ID
   * @param bundleName - 应用包名（可选）
   * @returns 崩溃日志内容
   * @throws 如果获取失败则抛出错误
   */
  async getCrashLog(deviceId: string, bundleName?: string): Promise<string> {
    debugLog(`Fetching crash logs from device: ${deviceId}`);
    const hdcPath = this.toolProvider.hdcPath;

    // 1. 列出崩溃日志文件
    const filenames = await this.listCrashLogs(hdcPath, deviceId, bundleName);

    // 2. 检查是否有日志文件
    if (filenames.length === 0) {
      return bundleName
        ? `No crash logs found for bundle '${bundleName}'.`
        : 'No crash logs found.';
    }

    // 3. 按照文件名末尾的时间戳进行排序，取最新的一个
    const sortedFilenames = [...filenames].sort((a, b) => {
      const aTs = a.split('-').pop() || '';
      const bTs = b.split('-').pop() || '';
      // 降序排序，最新的在前
      return bTs.localeCompare(aTs);
    });

    const latestFilename = sortedFilenames[0];

    // 4. 获取最新日志内容
    const content = await this.fetchCrashLogContent(
      hdcPath,
      deviceId,
      latestFilename
    );

    return `--- Latest Crash Log File: ${latestFilename} ---${content}`;
  }

  /**
   * 列出设备上的崩溃日志文件
   * @param hdcPath - hdc 工具路径
   * @param deviceId - 设备 ID
   * @param bundleName - 应用包名（可选，用于过滤）
   * @returns 崩溃日志文件名数组
   * @throws 如果获取失败则抛出错误
   */
  async listCrashLogs(
    hdcPath: string,
    deviceId: string,
    bundleName?: string
  ): Promise<string[]> {
    // 构建命令参数
    const listArgs = [
      '-t',
      deviceId,
      'shell',
      'hidumper',
      '-s',
      '1201',
      '-a',
      `-p Faultlogger`,
    ];

    debugLog(`Running command: ${hdcPath} ${listArgs.join(' ')}`);

    const result = await runHdcWithRetry(hdcPath, listArgs);
    const sentinel = detectHdcSentinel(result, 'Failed to list crash logs');
    if (sentinel) {
      throw sentinel;
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to list crash logs: ${result.stderr || result.stdout}`
      );
    }

    debugLog(`Crash logs list output:\n${result.stdout}`);

    // 解析输出，提取文件名
    const filenames: string[] = result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => {
        try {
          CommonUtils.assertCrashFilename(line);
          return true;
        } catch {
          return false;
        }
      })
      .filter((line) => {
        // 如果提供了 bundleName，只保留包含该名称的行（忽略大小写）
        if (!bundleName) {
          return true;
        }
        return line.toLowerCase().includes(bundleName.toLowerCase());
      });

    return filenames;
  }

  /**
   * 获取崩溃日志文件的内容
   * @param hdcPath - hdc 工具路径
   * @param deviceId - 设备 ID
   * @param filename - 日志文件名
   * @returns 崩溃日志内容
   * @throws 如果获取失败则抛出错误
   */
  async fetchCrashLogContent(
    hdcPath: string,
    deviceId: string,
    filename: string
  ): Promise<string> {
    debugLog(`Fetching latest crash log file: ${filename}`);

    const fetchArgs = [
      '-t',
      deviceId,
      'shell',
      'hidumper',
      '-s',
      '1201',
      '-a',
      `-p Faultlogger -f ${filename}`,
    ];

    debugLog(`Executing command: ${hdcPath} ${fetchArgs.join(' ')}`);

    const result = await runHdcWithRetry(hdcPath, fetchArgs);
    const sentinel = detectHdcSentinel(
      result,
      'Failed to fetch crash log content'
    );
    if (sentinel) {
      throw sentinel;
    }
    if (result.exitCode !== 0 && result.stderr) {
      console.error(
        `Warning: Failed to fetch crash logs: ${result.stderr}`
      );
    }

    const combinedOutput = result.stdout + result.stderr;
    return combinedOutput;
  }
}
