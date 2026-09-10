/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { randomUUID } from 'node:crypto';
import { execa } from 'execa';
import { ToolProvider } from '../toolchain/index.js';
import { debugLog } from './logger.js';
import { DeviceManager } from '../service/device-manager.js';
import { CommonUtils } from './common-utils.js';
import { classifyPidofResult, runHdcWithRetry } from './hdc-param.js';

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
    CommonUtils.assertBundleNameStrict(bundleName);
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
    CommonUtils.assertBundleNameStrict(bundleName);
    CommonUtils.assertAbilityName(mainAbility);
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

  /**
   * Whether `hdc shell pidof <bundle>` reports a live process.
   * Strict: queries the full bundle name only — no tail-segment fallback
   * (another app sharing the tail segment must never mask a crash).
   * Goes through runHdcWithRetry so transient hdc windows are waited out.
   * @throws when the probe itself fails (transport/spawn error, hdc error
   * text) — the process state is unknown, never "dead".
   */
  public async pidofBundle(
    target: string,
    bundleName: string
  ): Promise<boolean> {
    CommonUtils.assertBundleNameStrict(bundleName);
    const args = ['-t', target, 'shell', 'pidof', bundleName];
    const hdcPath = this.toolProvider.hdcPath;
    debugLog(`Executing: ${hdcPath} ${args.join(' ')}`);
    const result = await runHdcWithRetry(hdcPath, args);
    const outcome = classifyPidofResult(result);
    if (outcome === 'query-failed') {
      const detail = [result.stdout, result.stderr]
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ');
      throw new Error(
        `pidof query failed for '${bundleName}': ${detail || `exit ${result.exitCode}`}`
      );
    }
    return outcome === 'alive';
  }

  public async forceStopApp(
    target: string,
    bundleName: string
  ): Promise<string> {
    CommonUtils.assertBundleNameStrict(bundleName);
    const args = ['-t', target, 'shell', 'aa', 'force-stop', bundleName];
    return await this.runHdc(args, false);
  }

  /**
   * Transfer a file between the host and a connected device via
   * `hdc -t <serial> file <direction> <src> <dst>`.
   * - 'send' copies a local file onto the device: <local> <remote>.
   * - 'recv' copies a remote device file to the host: <remote> <local>.
   * Resolves with the trimmed hdc stdout ("FileTransfer finish") on success,
   * throws when hdc does not report a clean transfer.
   */
  public async transferFile(
    target: string,
    direction: 'send' | 'recv',
    src: string,
    dst: string
  ): Promise<string> {
    const args = ['-t', target, 'file', direction, src, dst];
    const stdout = await this.runHdc(args, false);
    if (!stdout.includes('FileTransfer finish')) {
      throw new Error(
        `File ${direction} failed: ${stdout.trim() || 'hdc returned no output'}`
      );
    }
    return stdout.trim();
  }

  /**
   * Run `hdc -t <target> shell sqlite3 <dbPath> [args...]`, forwarding stdio
   * so both one-shot queries and the interactive sqlite shell work.
   */
  public async runSqlite3(
    target: string,
    dbPath: string,
    sqliteArgs: string[] = []
  ): Promise<void> {
    const args = ['-t', target, 'shell', 'sqlite3', dbPath, ...sqliteArgs];
    await execa(this.toolProvider.hdcPath, args, {
      stdio: 'inherit',
      env: { ...process.env },
    });
  }
}
