/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import { ToolProvider } from '../toolchain/index.js';
import { debugLog } from './logger.js';
import { startMemoryTracker, formatBytesMb } from './process-rss.js';

export class OhpmAdapter {
  private toolProvider: ToolProvider;
  private projectRoot: string;
  peakMemoryMb = '';

  constructor(toolProvider: ToolProvider, projectRoot: string) {
    this.toolProvider = toolProvider;
    this.projectRoot = projectRoot;
  }

  public async installAll(): Promise<void> {
    const cmd = this.toolProvider.nodePath;
    const args = [this.toolProvider.ohpmJsPath, 'install', '--all'];

    debugLog(`Executing: ${cmd} ${args.join(' ')}`);

    const child = execa(cmd, args, {
      cwd: this.projectRoot,
      env: {
        ...process.env,
        DEVECO_SDK_HOME: this.toolProvider.sdkPath,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    });

    const tracker = startMemoryTracker(child.pid);
    try {
      await child;
    } finally {
      const peakBytes = await tracker.stop();
      if (peakBytes > 0) {
        this.peakMemoryMb = formatBytesMb(peakBytes);
      }
    }
  }
}
