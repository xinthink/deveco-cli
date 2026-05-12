/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import { ToolProvider } from '../utils/tool-provider.js';
import type { EmulatorInfo } from './emulator-types.js';
import { normalizeListNameKey } from './emulator-types.js';
import { spawnEmulatorDetached } from '../utils/emulator-spawn.js';
import { runAllEmulatorStartStrategies } from './emulator-start-strategies.js';
import { isEmulatorRunningByHdcName } from '../utils/emulator-hdc-targets.js';
import { parseEmulatorListOutput } from './emulator-list-parse.js';
import { parseDownloadedOsVersionsFromImageList } from '../utils/emulator-image-list-parse.js';

export class EmulatorManager {
  private emulatorPath: string;
  private sdkPath: string;
  private hdcPath: string;

  private constructor(emulatorPath: string, sdkPath: string, hdcPath: string) {
    this.emulatorPath = emulatorPath;
    this.sdkPath = sdkPath;
    this.hdcPath = hdcPath;
  }

  public static from(toolProvider: ToolProvider): EmulatorManager {
    return new EmulatorManager(
      toolProvider.emulatorPath,
      toolProvider.sdkPath,
      toolProvider.hdcPath
    );
  }

  private async executeEmulator(
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    return execa(this.emulatorPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEVECO_SDK_HOME: this.sdkPath },
    });
  }

  private executeEmulatorDetached(args: string[]): Promise<void> {
    return spawnEmulatorDetached(this.emulatorPath, this.sdkPath, args);
  }

  public async listEmulators(): Promise<EmulatorInfo[]> {
    const { stdout } = await this.executeEmulator(['-list', '-details']);
    return parseEmulatorListOutput(stdout);
  }

  public async startEmulator(
    name: string
  ): Promise<'started' | 'already-running'> {
    const emulators = await this.listEmulators();
    const nameKey = normalizeListNameKey(name);
    const targetEmulator = emulators.find(
      (e) => normalizeListNameKey(e.name) === nameKey
    );

    if (!targetEmulator) {
      throw new Error(`Emulator "${name}" not found.`);
    }

    const listName = targetEmulator.name;

    if (await this.isAlreadyRunning(listName, targetEmulator)) {
      return 'already-running';
    }

    const outcome = await runAllEmulatorStartStrategies(
      this.emulatorPath,
      this.sdkPath,
      listName,
      targetEmulator,
      (args) => this.executeEmulatorDetached(args)
    );
    if (outcome.ok) {
      return 'started';
    }

    if (await this.isAlreadyRunning(listName)) {
      return 'already-running';
    }

    throw new Error(
      `Unable to start emulator "${name}". All methods failed.\nLast error: ${outcome.lastError.message || 'unknown'}`
    );
  }

  /**
   * `-list -details` isRunning can lag; hdc HVD name confirms a live instance.
   */
  private async isAlreadyRunning(
    name: string,
    cached?: EmulatorInfo
  ): Promise<boolean> {
    if (cached?.isRunning === true) {
      return true;
    }
    if (cached === undefined) {
      const list = await this.listEmulators();
      if (list.find((e) => e.name === name)?.isRunning === true) {
        return true;
      }
    }
    return isEmulatorRunningByHdcName(this.hdcPath, name);
  }

  public async stopEmulator(name: string): Promise<void> {
    await this.executeEmulator(['-stop', name]);
  }

  private async executeEmulatorInherit(args: string[]): Promise<void> {
    const { exitCode } = await execa(this.emulatorPath, args, {
      stdio: 'inherit',
      env: { ...process.env, DEVECO_SDK_HOME: this.sdkPath },
      reject: false,
    });
    if (exitCode !== 0) {
      throw new Error(
        `emulator exited with code ${exitCode === null ? 'null' : exitCode}`
      );
    }
  }

  public async installEmulatorImage(opts: {
    deviceType: string;
    osVersion: string;
    force?: boolean;
  }): Promise<void> {
    const args = [
      '-install',
      '-deviceType',
      opts.deviceType,
      '-osVersion',
      opts.osVersion,
    ];
    if (opts.force) {
      args.push('-force');
    }
    await this.executeEmulatorInherit(args);
  }

  public async uninstallEmulatorImage(opts: {
    deviceType: string;
    osVersion: string;
  }): Promise<void> {
    const args = [
      '-uninstall',
      '-deviceType',
      opts.deviceType,
      '-osVersion',
      opts.osVersion,
      '-force',
    ];
    await this.executeEmulatorInherit(args);
  }

  public async listEmulatorImages(opts: {
    deviceType?: string;
    downloaded?: boolean;
  }): Promise<string> {
    const args: string[] = ['-imageList'];
    if (opts.deviceType) {
      args.push('-deviceType', opts.deviceType);
    }
    if (opts.downloaded !== undefined) {
      args.push('-downloaded', opts.downloaded ? 'true' : 'false');
    }
    const { stdout } = await this.executeEmulator(args);
    return stdout;
  }

  public async listDownloadedImageOsVersions(): Promise<string[]> {
    const stdout = await this.listEmulatorImages({ downloaded: true });
    return parseDownloadedOsVersionsFromImageList(stdout);
  }

  private async runEmulatorChecked(
    args: string[],
    options?: {
      extraReject?: RegExp[];
      printOutputOnSuccess?: boolean;
      transformOutput?: (text: string) => string;
    }
  ): Promise<void> {
    const { stdout, stderr, exitCode } = await execa(this.emulatorPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DEVECO_SDK_HOME: this.sdkPath },
      reject: false,
      maxBuffer: 20 * 1024 * 1024,
    });
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    const baseReject =
      /Invalid command|无效命令|鏃犳晥鍛戒护/i.test(combined) ||
      /please attach the correct parameter/i.test(combined);
    const extraReject = (options?.extraReject ?? []).some((re) =>
      re.test(combined)
    );
    const failed = exitCode !== 0 || baseReject || extraReject;
    if (failed) {
      throw new Error(
        combined ||
          `emulator exited with code ${exitCode === null ? 'null' : exitCode}`
      );
    }
    if (options?.printOutputOnSuccess !== false && combined) {
      const out = (
        options?.transformOutput ? options.transformOutput(combined) : combined
      ).trim();
      if (out) {
        console.log(out);
      }
    }
  }

  public async createVirtualDevice(opts: {
    name: string;
    deviceType: string;
    osVersion: string;
    force?: boolean;
  }): Promise<void> {
    const args = [
      '-create',
      opts.name,
      '-deviceType',
      opts.deviceType,
      '-osVersion',
      opts.osVersion,
    ];
    if (opts.force) {
      args.push('-force');
    }
    await this.runEmulatorChecked(args, {
      extraReject: [
        /Device create fail/i,
        /Invalid OS version/i,
        /cannot be empty/i,
      ],
      printOutputOnSuccess: true,
      transformOutput: (text) =>
        text
          .split(/\r?\n/)
          .map((line) => {
            const trimmed = line.trim();
            return trimmed.startsWith('Device create success.')
              ? 'Device create success.'
              : line;
          })
          .join('\n'),
    });
  }

  public async deleteVirtualDevice(userInputName: string): Promise<string> {
    const emulators = await this.listEmulators();
    const nameKey = normalizeListNameKey(userInputName);
    const target = emulators.find(
      (e) => normalizeListNameKey(e.name) === nameKey
    );
    if (!target) {
      throw new Error(`Emulator "${userInputName}" not found.`);
    }
    const listName = target.name;

    if (
      target.isRunning === true ||
      (await this.isAlreadyRunning(listName, target))
    ) {
      try {
        await this.executeEmulator(['-stop', listName]);
      } catch {}
    }

    await this.runEmulatorChecked(['-delete', listName, '-force'], {
      printOutputOnSuccess: false,
    });
    return listName;
  }
}
