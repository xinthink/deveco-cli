/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { HilogOptions } from './config.js';
import { ToolProvider } from './tool-provider.js';
import { DeviceManager } from '../service/device-manager.js';
import { cyan, red, yellow } from 'colorette';
import { spawn } from 'child_process';
import { CommonUtils } from './common-utils.js';
import { debugLog } from './logger.js';
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
      `${context}: device communication channel is not ready yet. Please retry in a few seconds.`
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

export class HilogAdapter {
  private toolProvider: ToolProvider;
  private deviceManager: DeviceManager;

  constructor(toolProvider: ToolProvider) {
    this.toolProvider = toolProvider;
    this.deviceManager = DeviceManager.from(toolProvider);
  }

  /**
   * 获取选择的设备
   * @param deviceArg 用户传入的 --device 参数（可以是设备 name 或 serial）
   */
  async selectDevice(deviceArg?: string): Promise<string | undefined> {
    const connectedDevices = await this.getConnectedDevices();
    if (!connectedDevices) {
      return undefined;
    }

    if (deviceArg) {
      const found = connectedDevices.find(
        (d) => d.serial === deviceArg || d.name.includes(deviceArg)
      );
      if (found) {
        debugLog(cyan(`Using device: ${found.name} (${found.serial})`));
        return found.serial;
      }
      const list = connectedDevices
        .map((d) => `  - ${d.name} (${d.serial})`)
        .join('\n');
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
      'Multiple devices found. Please specify a target device using `--device <name>` or `--device <serial>`.\nAvailable devices:\n' +
        connectedDevices.map((d) => `  - ${d.name} (${d.serial})`).join('\n')
    );
  }

  /**
   * 获取已连接的设备列表
   */
  private async getConnectedDevices(): Promise<ConnectedDevice[] | null> {
    try {
      const devices = await this.deviceManager.listDevicesWithName();

      if (devices.length === 0) {
        console.error(red('No running device found.'));
        console.error('Please ensure:');
        console.error(
          '  1. The physical device is connected via USB and debugging mode is enabled'
        );
        console.error('  2. Or an emulator is running');
        return null;
      }

      return devices;
    } catch (error) {
      console.error(
        red(`Failed to retrieve the device list: ${(error as Error).message}`)
      );
      return null;
    }
  }

  /**
   * 提示用户选择设备
   */
  private async promptDeviceSelection(
    devices: ConnectedDevice[]
  ): Promise<string | undefined> {
    console.log(yellow('Multiple devices detected:'));
    devices.forEach((device, index) => {
      console.log(`  ${index + 1}. ${device.name} (${device.serial})`);
    });

    const selectedIndex = await this.getUserInput(devices.length);
    if (selectedIndex === null) {
      return undefined;
    }

    return devices[selectedIndex].serial;
  }

  /**
   * 获取用户输入的设备索引
   */
  private async getUserInput(maxIndex: number): Promise<number | null> {
    const readline = await import('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>((resolve) => {
      rl.question('Please enter the device ID: ', (input) => {
        rl.close();
        resolve(input);
      });
    });

    const index = parseInt(answer) - 1;
    if (index >= 0 && index < maxIndex) {
      return index;
    }

    console.error(red('Invalid device ID'));
    return null;
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
    debugLog(`Trying to get PID for bundle: ${bundleName}`);
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
    // 基础命令参数
    // 使用 -x 参数确保 hilog 读取完当前缓冲区后退出，否则命令会挂起等待新日志
    let args: string[];
    if (options.isFollow) {
      args = ['-t', deviceId, 'shell', 'hilog'];
    } else {
      args = ['-t', deviceId, 'shell', 'hilog', '-x'];
    }

    if (options.tag) {
      CommonUtils.assertHilogToken(options.tag, 'tag');
      args.push('-T', options.tag);
    }

    // 添加日志级别过滤
    if (options.level) {
      CommonUtils.assertHilogLevel(options.level);
      args.push('-L', options.level);
    }

    // 添加领域过滤
    if (options.domain) {
      CommonUtils.assertHilogToken(options.domain, 'domain');
      args.push('-D', options.domain);
    }

    // 添加进程 ID 过滤
    if (pid) {
      args.push('-P', pid);
    }

    // 添加关键字过滤
    if (options.keyword) {
      CommonUtils.assertHilogKeyword(options.keyword);
      args.push('-e', CommonUtils.quotePosixShellArg(options.keyword));
    }

    // 返回命令和参数
    return [hdcPath, args];
  }

  /**
   * 实时跟随日志输出（不缓存 stdout/stderr，避免 maxBuffer 溢出）
   */
  private async followHilog(command: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: 'inherit',
      });

      child.on('error', (error) => {
        reject(error);
      });

      child.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve();
          return;
        }

        reject(
          new Error(`Failed to follow hilog: process exited with code ${code}`)
        );
      });
    });
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
    debugLog(`Ready to execute hilog command: ${command} ${args.join(' ')}`);

    const result = await runHdcWithRetry(hdcPath, args);
    const sentinel = detectHdcSentinel(result, 'Failed to get hilog');
    if (sentinel) {
      throw sentinel;
    }
    if (result.exitCode !== 0 && result.stderr) {
      throw new Error(`Failed to get hilog: ${result.stderr}`);
    }

    let logs = CommonUtils.filterLogsByRelativeWindow(
      result.stdout || result.stderr,
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
      `Ready to execute hilog command which contain follow and tail: ${command} ${args.join(' ')}`
    );
    await this.followHilog(command, args);
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
        `No running process found for bundle '${options.bundleName}'. Make sure the app is launched on the device before fetching logs.`
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

    debugLog(`Executing command: ${hdcPath} ${listArgs.join(' ')}`);

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
        `Warning: Failed to fetch crash log content: ${result.stderr}`
      );
    }

    const combinedOutput = result.stdout + result.stderr;
    return combinedOutput;
  }
}
