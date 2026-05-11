/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { ToolProvider } from '../utils/tool-provider.js';
import * as os from 'os';
import { join } from 'path';
import { existsSync, statSync } from 'fs';
import { DeviceInfo } from '../utils/config.js';
import { runCommand } from '../utils/cmd.js';
import { tryGetHdcShellParam } from '../utils/hdc-param.js';

export class EmulatorService {
  private toolProvider: ToolProvider;

  constructor(toolProvider: ToolProvider) {
    this.toolProvider = toolProvider;
  }

  /**
   * 获取所有可用设备（包括已连接和已安装的模拟器）
   */
  async getAvailableDevices(): Promise<DeviceInfo[]> {
    const connectedDevices = await this.getConnectedDevices();
    const installedEmulators =
      await this.getInstalledEmulators(connectedDevices);
    return [...connectedDevices, ...installedEmulators];
  }

  /**
   * 获取已连接的设备列表
   */
  private async getConnectedDevices(): Promise<DeviceInfo[]> {
    const hdcPath = this.toolProvider.hdcPath;
    const connectedIds = await this.getConnectedDevicesIds(hdcPath);
    const devices: DeviceInfo[] = [];
    for (const id of connectedIds) {
      const device = await this.createDeviceInfo(id, hdcPath);
      if (device) {
        devices.push(device);
      }
    }
    return devices;
  }

  /**
   * 创建单个已连接设备的信息
   */
  private async createDeviceInfo(
    id: string,
    hdcPath: string
  ): Promise<DeviceInfo | null> {
    const isEmulator = this.isEmulatorDevice(id);
    try {
      const name = isEmulator
        ? await this.getEmulatorName(hdcPath, id)
        : await this.getRealDeviceName(hdcPath, id);
      return { deviceId: id, isEmulator, name, isConnected: true };
    } catch (error) {
      const deviceType = isEmulator ? 'emulator' : 'real device';
      console.error(
        `get ${deviceType} name error: ${(error as Error).message}`
      );
      return null;
    }
  }

  /**
   * 获取已安装但未运行的模拟器列表
   */
  private async getInstalledEmulators(
    connectedDevices: DeviceInfo[]
  ): Promise<DeviceInfo[]> {
    const emulatorPath = this.getEmulatorExecutable();
    if (!emulatorPath) {
      return [];
    }
    try {
      const emulatorList = await this.listEmulatorsInternal(emulatorPath);
      return emulatorList
        .filter(
          (emuName) =>
            !connectedDevices.some((d) => d.isEmulator && d.name === emuName)
        )
        .map((emuName) => ({
          deviceId: '',
          isEmulator: true,
          name: emuName,
          isConnected: false,
        }));
    } catch (error) {
      console.error(
        `get list emulators internal error: ${(error as Error).message}`
      );
      return [];
    }
  }

  /**
   * 获取已连接设备的 ID 列表
   * @param hdcPath - hdc 工具的路径
   * @returns 设备 ID 的 Set 集合
   */
  async getConnectedDevicesIds(hdcPath: string): Promise<Set<string>> {
    // 执行 hdc list targets 命令
    const result = await runCommand(hdcPath, ['list', 'targets']);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to run hdc: ${result.stderr}`);
    }

    const stdout = result.stdout;
    const ids = new Set<string>();

    // 逐行解析输出
    for (const line of stdout.split('\n')) {
      const trimmedLine = line.trim();

      // 跳过空行和 "[Empty]" 标记
      if (!trimmedLine || trimmedLine === '[Empty]') {
        continue;
      }

      // 提取第一个字段作为设备 ID
      // 格式通常是: 127.0.0.1:5555 或 device_id
      const id = trimmedLine.split(/\s+/)[0];
      if (id && id.length > 0) {
        ids.add(id);
      }
    }
    return ids;
  }

  /**
   * 判断设备 ID 是否是模拟器
   * 模拟器设备 ID 通常包含 IP 地址格式，如 127.0.0.1:5555
   * @param id - 设备 ID
   * @returns 是否是模拟器设备
   */
  isEmulatorDevice(id: string): boolean {
    // 正则表达式：匹配包含 IP:端口 格式的字符串
    // 模式：.*\d+\.\d+\.\d+\.\d+:\d+.*
    const emulatorRegex = /.*\d+\.\d+\.\d+\.\d+:\d+.*/;
    return emulatorRegex.test(id);
  }

  /**
   * 获取模拟器名称
   * 通过 hdc 命令获取模拟器的 HVD 名称
   * @param hdcPath - hdc 工具的路径
   * @param id - 设备 ID
   * @returns 模拟器名称
   */
  async getEmulatorName(hdcPath: string, id: string): Promise<string> {
    const v = await tryGetHdcShellParam(hdcPath, id, 'ohos.qemu.hvd.name');
    if (v === undefined) {
      throw new Error('Failed to get emulator name');
    }
    return v;
  }

  /**
   * 获取真机设备名称
   * 通过 hdc 命令获取设备的产品名称
   * @param hdcPath - hdc 工具的路径
   * @param id - 设备 ID
   * @returns 设备名称
   */
  async getRealDeviceName(hdcPath: string, id: string): Promise<string> {
    const v = await tryGetHdcShellParam(hdcPath, id, 'const.product.name');
    if (v === undefined) {
      throw new Error('Failed to get device name');
    }
    return v;
  }

  /**
   * 获取模拟器可执行文件路径
   * 按照以下优先级查找：
   * 1. 配置中的 emulatorLuncherPath + 可执行文件名
   * 2. 如果 emulatorLuncherPath 本身是文件，直接使用
   * 3. SDK 路径下的 emulator 目录
   * @param config - 配置数据
   * @returns 模拟器可执行文件路径，如果找不到则返回 null
   */
  getEmulatorExecutable(): string | null {
    const emulatorLuncherPath = this.toolProvider.sdkPath;
    const platform = os.platform();
    const emulatorName = platform === 'win32' ? 'emulator.exe' : 'emulator';

    // 1. 首先检查配置中的 emulatorLuncherPath
    if (emulatorLuncherPath) {
      // 尝试在配置路径下查找模拟器可执行文件
      const execPath = join(emulatorLuncherPath, emulatorName);
      if (existsSync(execPath)) {
        return execPath;
      }
      // 如果配置的路径本身就是一个文件，直接返回
      if (existsSync(emulatorLuncherPath)) {
        const stat = statSync(emulatorLuncherPath);
        if (stat.isFile()) {
          return emulatorLuncherPath;
        }
      }
    }

    // 2. 检查 SDK 路径下的模拟器
    const sdkPath = this.toolProvider.sdkPath;
    const emulatorPath = join(sdkPath, 'emulator', emulatorName);

    if (existsSync(emulatorPath)) {
      return emulatorPath;
    }

    // 3. 找不到模拟器可执行文件
    return null;
  }

  /**
   * 获取已安装的模拟器列表
   * 通过模拟器可执行文件的 -list 参数获取所有已安装的模拟器名称
   * @param emulatorPath - 模拟器可执行文件路径
   * @returns 模拟器名称列表
   */
  async listEmulatorsInternal(emulatorPath: string): Promise<string[]> {
    // 执行命令：emulator -list
    const result = await runCommand(emulatorPath, ['-list']);

    if (result.exitCode !== 0) {
      throw new Error(`Failed to list emulators: ${result.stderr}`);
    }

    const stdout = result.stdout;
    const names: string[] = [];

    // 逐行解析输出，过滤空行
    for (const line of stdout.split('\n')) {
      const trimmedLine = line.trim();
      if (trimmedLine) {
        names.push(trimmedLine);
      }
    }
    return names;
  }
}
