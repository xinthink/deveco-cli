/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { ToolProvider } from './tool-provider.js';
import { debugLog } from './logger.js';

export interface DeviceInfo {
  name: string;
  id: string;
}

export class HdcAdapter {
  private toolProvider: ToolProvider;

  constructor(toolProvider: ToolProvider) {
    this.toolProvider = toolProvider;
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

  public async listTargets(): Promise<DeviceInfo[]> {
    const stdout = await this.runHdc(['list', 'targets']);
    const lines = stdout.split('\n');
    const devices: DeviceInfo[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('[Empty]')) {
        continue;
      }

      const id = trimmed.split(/\s+/)[0];
      const name = await this.getDeviceName(id);
      devices.push({ name, id });
    }

    return devices;
  }

  private async getDeviceName(target: string): Promise<string> {
    try {
      // Try emulator name
      let stdout = await this.runHdc(
        ['-t', target, 'shell', 'param', 'get', 'ohos.qemu.hvd.name'],
        false
      );
      stdout = stdout.trim();
      if (
        stdout &&
        !stdout.includes('fail!') &&
        !stdout.includes('not found')
      ) {
        return stdout;
      }

      // Try physical device name
      stdout = await this.runHdc(
        ['-t', target, 'shell', 'param', 'get', 'const.product.name'],
        false
      );
      stdout = stdout.trim();
      if (
        stdout &&
        !stdout.includes('fail!') &&
        !stdout.includes('not found')
      ) {
        if (stdout !== 'emulator') {
          return stdout;
        }
      }

      // Fallback to model
      stdout = await this.runHdc(
        ['-t', target, 'shell', 'param', 'get', 'const.product.model'],
        false
      );
      stdout = stdout.trim();
      if (
        stdout &&
        !stdout.includes('fail!') &&
        !stdout.includes('not found')
      ) {
        return stdout;
      }
    } catch {
      // Ignore
    }

    return 'Unknown Device';
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
        let sendRes = await this.runHdc([
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
      let installRes = await this.runHdc([
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
}
