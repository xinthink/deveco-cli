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
}
