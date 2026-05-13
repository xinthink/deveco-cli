/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import * as path from 'path';
import { ToolProvider } from './tool-provider.js';
import { debugLog } from './logger.js';

export class HvigorAdapter {
  private toolProvider: ToolProvider;
  private projectRoot: string;
  private env: Record<string, string>;

  constructor(toolProvider: ToolProvider, projectRoot: string) {
    this.toolProvider = toolProvider;
    this.projectRoot = projectRoot;

    const javaBinDir = path.dirname(toolProvider.javaPath);
    const newPath = `${javaBinDir}${path.delimiter}${process.env.PATH || ''}`;

    this.env = {
      ...process.env,
      PATH: newPath,
      DEVECO_SDK_HOME: toolProvider.sdkPath,
    } as Record<string, string>;
  }

  public async sync(productName: string, buildMode: string): Promise<void> {
    const args: string[] = [
      '--sync',
      '-p',
      `product=${productName}`,
      '-p',
      `buildMode=${buildMode}`,
      '--analyze=normal',
      '--parallel',
      '--incremental',
    ];

    await this.runHvigor(args);
  }

  public async buildProduct(
    productName: string,
    buildMode: string
  ): Promise<void> {
    const args: string[] = [
      'assembleApp',
      '-p',
      `product=${productName}`,
      '-p',
      `buildMode=${buildMode}`,
      '--analyze=normal',
      '--parallel',
      '--incremental',
    ];

    await this.runHvigor(args);
  }

  public async buildModules(
    productName: string,
    buildMode: string,
    modules: string[],
    moduleTasks: Set<string>
  ): Promise<void> {
    const args: string[] = [
      ...Array.from(moduleTasks),
      '--mode',
      'module',
      '-p',
      `module=${modules.join(',')}`,
      '-p',
      `product=${productName}`,
      '-p',
      `buildMode=${buildMode}`,
      '--analyze=normal',
      '--parallel',
      '--incremental',
    ];

    await this.runHvigor(args);
  }

  public async clean(): Promise<void> {
    const args: string[] = [
      'clean',
      '--analyze=normal',
      '--parallel',
      '--no-daemon',
    ];

    await this.runHvigor(args);
  }

  private async runHvigor(args: string[]): Promise<void> {
    const cmd = this.toolProvider.nodePath;
    const cmdArgs = [this.toolProvider.hvigorJsPath, ...args];

    debugLog(`Executing: ${cmd} ${cmdArgs.join(' ')}`);

    await execa(cmd, cmdArgs, {
      cwd: this.projectRoot,
      env: this.env,
      stdout: 'inherit',
      stderr: 'inherit',
    });
  }
}
