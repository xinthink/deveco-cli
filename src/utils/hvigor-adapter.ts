/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import * as net from 'net';
import * as path from 'path';
import { ToolProvider } from '../toolchain';
import * as fs from 'fs';
import * as os from 'os';
import { debugLog } from './logger.js';

interface DaemonInfo {
  pid: number;
  state: string;
  cwdPath: string;
  port: number;
}

export class HvigorAdapter {
  private toolProvider: ToolProvider;
  private projectRoot: string;
  private env: Record<string, string>;
  private silent: boolean;

  constructor(toolProvider: ToolProvider, projectRoot: string, silent = false) {
    this.toolProvider = toolProvider;
    this.projectRoot = projectRoot;
    this.silent = silent;

    const javaBinDir = path.dirname(toolProvider.javaPath);
    const newPath = `${javaBinDir}${path.delimiter}${process.env.PATH || ''}`;

    const env: Record<string, string> = {
      ...process.env,
      PATH: newPath,
      DEVECO_SDK_HOME: toolProvider.sdkPath,
    };
    if (toolProvider.sourceType === 'clt' && toolProvider.javaPath) {
      env.JAVA_HOME = path.dirname(javaBinDir);
    }

    this.env = env as Record<string, string>;
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

  public async stopDaemon(): Promise<void> {
    await this.runHvigor(['--stop-daemon']);
  }

  public async ensureDaemonRunning(): Promise<void> {
    if (this.findProjectDaemon()) {
      debugLog('[HvigorAdapter] Daemon already running.');
      return;
    }
    debugLog('[HvigorAdapter] No daemon running, starting via --sync --daemon (no hap build).');
    await this.runHvigor(['--sync', '--daemon']);
  }

  public isDaemonRunning(projectRoot?: string): boolean {
    return this.findProjectDaemon(projectRoot) !== null;
  }

  public async isDaemonAlive(projectRoot?: string): Promise<boolean> {
    const daemon = this.findProjectDaemon(projectRoot);
    if (!daemon) {
      return false;
    }
    return this.isPortListening(daemon.port);
  }

  private isPortListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(2000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
      socket.connect(port, '127.0.0.1');
    });
  }

  public findProjectDaemon(projectRoot?: string): DaemonInfo | null {
    const registryPath = this.getDaemonRegistryPath();
    if (!fs.existsSync(registryPath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(registryPath, 'utf-8');
      const registry = JSON.parse(content) as Record<string, DaemonInfo>;
      const cwd = projectRoot ?? this.projectRoot;

      const alive = Object.values(registry).filter(
        (d) =>
          d.cwdPath === cwd &&
          (d.state === 'idle' || d.state === 'half_busy' || d.state === 'busy') &&
          this.isProcessAlive(d.pid)
      );

      return alive.length > 0 ? alive[alive.length - 1] : null;
    } catch {
      return null;
    }
  }

  private getDaemonRegistryPath(): string {
    const hvigorHome =
      process.env.HVIGOR_USER_HOME || path.join(os.homedir(), '.hvigor');
    return path.join(hvigorHome, 'daemon', 'cache', 'daemon-sec.json');
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }


  /**
   * 只触发 native（c/c++）编译，不生成 hap/har。
   */
  public async compileNative(productName: string, moduleName?: string): Promise<void> {
    const args: string[] = ['--mode', 'module'];
    if (moduleName) {
      args.push('-p', `module=${moduleName}`);
    }
    args.push('-p', `product=${productName}`, 'compileNative', '--analyze=normal');
    await this.runHvigor(args);
  }

  private async runHvigor(args: string[]): Promise<void> {
    const cmd = this.toolProvider.nodePath;
    const cmdArgs = [this.toolProvider.hvigorJsPath, ...args];

    debugLog(`Executing: ${cmd} ${cmdArgs.join(' ')}`);

    const stdioOpt = this.silent && !process.env.DEVECO_CLI_DEBUG ? 'pipe' : 'inherit';

    await execa(cmd, cmdArgs, {
      cwd: this.projectRoot,
      env: this.env,
      stdout: stdioOpt,
      stderr: stdioOpt,
    });
  }
}
