/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { runCommand } from './cmd.js';
import { DeviceInfo, HilogOptions } from './config.js';
import { CommonUtils } from './common-utils.js';
import { ToolProvider } from './tool-provider.js';
import { EmulatorService } from '../service/emulator-service.js';
import { blue, red, yellow } from 'colorette';
import { spawn } from 'child_process';

export class HilogAdapter {
  private toolProvider: ToolProvider;
  private emulatorService: EmulatorService;

  constructor(toolProvider: ToolProvider) {
    this.toolProvider = toolProvider;
    this.emulatorService = new EmulatorService(toolProvider);
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
        (d) => d.deviceId === deviceArg || d.name.includes(deviceArg),
      );
      if (found) {
        console.log(blue(`Use the device: ${found.name} (${found.deviceId})`));
        return found.deviceId;
      }
      const list = connectedDevices
        .map((d) => `  - ${d.name} (${d.deviceId})`)
        .join('\n');
      throw new Error(
        `Device '${deviceArg}' not found.\nAvailable devices:\n${list}`,
      );
    }

    if (connectedDevices.length === 1) {
      const device = connectedDevices[0];
      console.log(blue(`Use the device: ${device.name} (${device.deviceId})`));
      return device.deviceId;
    }

    return await this.promptDeviceSelection(connectedDevices);
  }

  /**
   * 获取已连接的设备列表
   */
  private async getConnectedDevices(): Promise<DeviceInfo[] | null> {
    try {
      const devices = await this.getDevices();
      const connectedDevices = devices.filter((d: DeviceInfo) => d.isConnected);

      if (connectedDevices.length === 0) {
        console.error(red('Error:No runnung device found.'));
        console.log('Please ensure:');
        console.log('  1. The physical device is connected via USB and debugging mode is enabled');
        console.log('  2. Or an emulator is running');
        return null;
      }

      return connectedDevices;
    } catch (error) {
      console.error(red(`Failed to retrieve the device list: ${(error as Error).message}`));
      return null;
    }
  }

  /**
   * 提示用户选择设备
   */
  private async promptDeviceSelection(devices: DeviceInfo[]): Promise<string | undefined> {
    console.log(yellow('Multiple devices detected:'));
    devices.forEach((device: DeviceInfo, index: number) => {
      console.log(`  ${index + 1}. ${device.name} (${device.deviceId})`);
    });

    const selectedIndex = await this.getUserInput(devices.length);
    if (selectedIndex === null) {
      return undefined;
    }

    return devices[selectedIndex].deviceId;
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
   * 获取可使用的设备信息列表
   * @returns 设备信息列表
   */
  async getDevices(): Promise<DeviceInfo[]> {
    return await this.emulatorService.getAvailableDevices();
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
    console.log(`Trying to get PID for bundle: ${bundleName}`);

    // 执行命令: hdc -t <device_id> shell pidof <bundle_name>
    const result = await runCommand(hdcPath, ['-t', deviceId, 'shell', 'pidof', bundleName]);

    // 检查命令是否成功执行
    if (result.exitCode === 0 && result.stdout.trim()) {
      const pidStr = result.stdout.trim();

      // pidof 可能返回多个 PID，用空格分隔，取第一个
      const firstPid = pidStr.split(/\s+/)[0] || pidStr;

      console.log(`Found PID for ${bundleName}: ${firstPid}`);
      return firstPid;
    }

    console.log(`No PID found for bundle: ${bundleName}`);
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
    console.log(`Setting hilog buffer size to: ${size}`);
    // 执行命令: hdc -t <device_id> shell hilog -G <size>
    const result = await runCommand(hdcPath, ['-t', deviceId, 'shell', 'hilog', '-G', size]);

    // 检查命令是否成功执行
    if (result.exitCode !== 0) {
      console.log(`Failed to resize hilog buffer: ${result.stderr || result.stdout}`);
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

    // 添加标签过滤
    if (options.tag) {
      args.push('-T', options.tag);
    }

    // 添加日志级别过滤
    if (options.level) {
      args.push('-L', options.level);
    }

    // 添加领域过滤
    if (options.domain) {
      args.push('-D', options.domain);
    }

    // 添加进程 ID 过滤
    if (pid) {
      args.push('-P', pid);
    }

    // 添加关键字过滤
    if (options.keyword) {
      args.push('-e', options.keyword);
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

        reject(new Error(`Failed to follow hilog: process exited with code ${code}`));
      });
    });
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
    // 1. 如果提供了 bundle_name，获取进程 ID
    const pid = options.bundleName
      ? await this.getPidForBundle(hdcPath, deviceId, options.bundleName)
      : undefined;

    // 2. 如果提供了 log_size，调整缓冲区大小
    if (options.logSize) {
      await this.resizeHilogBuffer(hdcPath, deviceId, options.logSize);
    }

    if (options.isFollow) {
      if (options.tail) {
        const snapshotOptions = { ...options, isFollow: false };
        const [snapshotCommand, snapshotArgs] = this.buildHilogCommand(
          hdcPath,
          deviceId,
          snapshotOptions,
          pid || '',
        );
        const snapshotResult = await runCommand(snapshotCommand, snapshotArgs);
        if (snapshotResult.exitCode !== 0 && snapshotResult.stderr) {
          throw new Error(`Failed to get hilog: ${snapshotResult.stderr}`);
        }
        const snapshotLogs = CommonUtils.getLastLines(
          snapshotResult.stdout || snapshotResult.stderr,
          options.tail,
        );
        if (snapshotLogs.trim()) {
          console.log(snapshotLogs);
        }
      }

      // 3. 构建跟随命令
      const [command, args] = this.buildHilogCommand(hdcPath, deviceId, options, pid || '');
      console.log(`Ready to execute hilog command: ${command} ${args.join(' ')}`);
      await this.followHilog(command, args);
      return '';
    }

    // 3. 构建命令
    const [command, args] = this.buildHilogCommand(hdcPath, deviceId, options, pid || '');
    console.log(`Ready to execute hilog command: ${command} ${args.join(' ')}`);

    const result = await runCommand(command, args);
    if (result.exitCode !== 0 && result.stderr) {
      throw new Error(`Failed to get hilog: ${result.stderr}`);
    }

    return CommonUtils.getLastLines(result.stdout || result.stderr, options.tail);
  }

  /**
   * 获取设备的崩溃日志工具路径
   * @param deviceId - 设备 ID
   * @param bundleName - 应用包名（可选）
   * @returns 崩溃日志内容
   * @throws 如果获取失败则抛出错误
   */
  async getCrashLog(
    deviceId: string,
    bundleName?: string
  ): Promise<string> {
    console.log(`Fetching crash logs from device: ${deviceId}`);
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
    const content = await this.fetchCrashLogContent(hdcPath, deviceId, latestFilename);

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
    const listArgs = ['-t', deviceId, 'shell', 'hidumper', '-s', '1201', '-a', '-p', 'Faultlogger'];

    console.log(`Executing command: ${hdcPath} ${listArgs.join(' ')}`);

    // 执行命令
    const result = await runCommand(hdcPath, listArgs);

    // 检查命令是否成功
    if (result.exitCode !== 0) {
      throw new Error(`Failed to list crash logs: ${result.stderr || result.stdout}`);
    }

    console.log(`Crash logs list output:\n${result.stdout}`);

    // 解析输出，提取文件名
    const filenames: string[] = result.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => {
        // 如果提供了 bundleName，只保留包含该名称的行（忽略大小写）
        if (!bundleName) {
          return true;
        }
        return line.toLowerCase().includes(bundleName.toLowerCase());
      })
      .filter(line => line.length > 0); // 过滤空行

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
    console.log(`Fetching latest crash log file: ${filename}`);

    // 构建命令参数
    // 命令格式: hdc -t <device_id> shell hidumper -s 1201 -a -p Faultlogger -f <filename>
    const fetchArgs = [
      '-t',
      deviceId,
      'shell',
      'hidumper',
      '-s',
      '1201',
      '-a',
      `-p Faultlogger -f ${filename}`
    ];

    console.log(`Executing command: ${hdcPath} ${fetchArgs.join(' ')}`);

    // 执行命令
    const result = await runCommand(hdcPath, fetchArgs);

    // 检查命令是否成功（原代码没有显式检查，直接返回输出）
    if (result.exitCode !== 0 && result.stderr) {
      console.warn(`Warning: Failed to fetch crash log content: ${result.stderr}`);
    }

    // 返回合并的输出（stdout + stderr）
    const combinedOutput = result.stdout + result.stderr;
    return combinedOutput;
  }
}