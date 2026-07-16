/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import { ToolProvider } from '../toolchain/index.js';
import { debugLog } from './logger.js';

export class OhpmAdapter {
  private toolProvider: ToolProvider;
  private projectRoot: string;

  constructor(toolProvider: ToolProvider, projectRoot: string) {
    this.toolProvider = toolProvider;
    this.projectRoot = projectRoot;
  }

  public async installAll(): Promise<void> {
    const cmd = this.toolProvider.nodePath;
    const args = [this.toolProvider.ohpmJsPath, 'install', '--all'];

    debugLog(`Executing: ${cmd} ${args.join(' ')}`);

    const isDebug = Boolean(process.env.DEVECO_CLI_DEBUG);

    await execa(cmd, args, {
      cwd: this.projectRoot,
      env: {
        ...process.env,
        DEVECO_SDK_HOME: this.toolProvider.sdkPath,
      },
      stdout: isDebug ? 'inherit' : 'pipe',
      stderr: isDebug ? 'inherit' : 'pipe',
    });
  }
}
