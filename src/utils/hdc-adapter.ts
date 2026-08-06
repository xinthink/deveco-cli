/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { ToolProvider } from '../toolchain/index.js';
import { debugLog } from './logger.js';
import { DeviceManager } from '../service/device-manager.js';

export interface DeviceInfo {
  name: string;
  id: string;
}

export class HdcAdapter {
  private toolProvider: ToolProvider;
  private deviceManager: DeviceManager;

  constructor(toolProvider: ToolProvider) {
    this.toolProvider = toolProvider;
    this.deviceManager = DeviceManager.from(toolProvider);
  }

  private async runHdc(args: string[], throwOnError = true): Promise<string> {
    const cmd = this.toolProvider.hdcPath;
    debugLog(`Executing: ${cmd} ${args.join(' ')}`);

    try {
      const { stdout } = await execa(cmd, args, {
        env: { ...process.env },
      });
      return stdout;
    } catch (error) {
      if (throwOnError) {
        throw error;
      }
      return (error as { stdout?: string }).stdout || '';
    }
  }

  /**
   * Connected devices in legacy `{name, id}` shape, suitable for `run` /
   * `install` flows. Backed by `DeviceManager` so display-name resolution
   * stays consistent across all commands.
   */
  public async listTargets(): Promise<DeviceInfo[]> {
    const entries = await this.deviceManager.listDevicesWithName();
    return entries.map((e) => ({ name: e.name, id: e.serial }));
  }

  public async uninstallApp(
    target: string,
    bundleName: string
  ): Promise<boolean> {
    const stdout = await this.runHdc(
      ['-t', target, 'shell', 'bm', 'uninstall', '-n', bundleName],
      false
    );
    if (stdout.includes('uninstall bundle successfully')) {
      return true;
    }
    if (stdout.includes('uninstall missing installed bundle')) {
      return false;
    }
    throw new Error(`Uninstall failed: ${stdout}`);
  }

  public async installApp(target: string, apkPaths: string[]): Promise<void> {
    if (apkPaths.length === 0) {
      return;
    }

    const uuid = randomUUID();
    const remoteDir = `/data/local/tmp/${uuid}`;

    try {
      // 1. Create remote directory
      await this.runHdc(['-t', target, 'shell', 'mkdir', remoteDir]);

      // 2. Push all packages to the remote directory
      for (const localPath of apkPaths) {
        const sendRes = await this.runHdc([
          '-t',
          target,
          'file',
          'send',
          localPath,
          remoteDir + '/',
        ]);
        if (!sendRes.startsWith('FileTransfer finish')) {
          throw new Error(sendRes);
        }
      }

      // 3. Install from the temporary directory
      // Using 'bm install -p' for directory installation
      const installRes = await this.runHdc([
        '-t',
        target,
        'shell',
        'bm',
        'install',
        '-p',
        remoteDir,
      ]);
      if (!installRes.includes('install bundle successfully.')) {
        throw new Error(installRes);
      }
      console.log(`App installed successfully`);
    } finally {
      // 4. Remove the temporary directory
      await this.runHdc(['-t', target, 'shell', 'rm', '-rf', remoteDir], false);
    }
  }

  public async launchApp(
    target: string,
    bundleName: string,
    mainAbility: string
  ): Promise<string> {
    await this.wakeUpScreen(target);
    const args = [
      '-t',
      target,
      'shell',
      'aa',
      'start',
      '-a',
      mainAbility,
      '-b',
      bundleName,
    ];
    return await this.runHdc(args);
  }

  public async forceStopApp(target: string, bundleName: string): Promise<string> {
    const args = ['-t', target, 'shell', 'aa', 'force-stop', bundleName];
    return await this.runHdc(args, false);
  }

  public async wakeUpScreen(target: string): Promise<string> {
    return await this.runHdc(['-t', target, 'shell', 'power-shell', 'wakeup'], false);
  }
}
