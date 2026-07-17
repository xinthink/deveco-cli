/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execa } from 'execa';
import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolProvider } from '../toolchain/index.js';
import { debugLog } from '../utils/logger.js';
import { Project } from '../utils/project.js';
import {
  createCodelinterReport,
  extractJsonFromNativeStdout,
  filterCodelinterNativeText,
} from './report-parser.js';
import type { CodelinterCheckRequest, CodelinterCheckResult } from './types.js';

type CodelinterToolchainSource = 'ide' | 'command-line-tools';

interface CodelinterResolution {
  command: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
  workingDirectory?: string;
  runtimeDirectories?: string[];
}

interface CodelinterRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ResolvedLintTarget {
  path: string;
  projectRoot?: string;
}

const TEMP_DIRECTORY_PREFIX = 'deveco-codelinter-';

/** 封装 Code Linter 工具链解析、命令执行和报告标准化。 */
export class CodelinterAdapter {
  private readonly resolution: CodelinterResolution;
  private readonly cwd: string;

  /** 使用指定工具链和工作目录创建 Code Linter 适配器。 */
  constructor(toolProvider: ToolProvider, cwd: string) {
    this.resolution = CodelinterAdapter.resolveWithToolProvider(toolProvider);
    this.cwd = cwd;
  }

  /** 从工作目录解析项目根目录，未发现项目时返回工作目录。 */
  public static resolveProjectRoot(cwd: string): string {
    try {
      return Project.discover(cwd).rootDir;
    } catch {
      return cwd;
    }
  }

  /** 执行一次 Code Linter 检查并返回标准化报告和诊断信息。 */
  public async check(
    request: CodelinterCheckRequest
  ): Promise<CodelinterCheckResult> {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), TEMP_DIRECTORY_PREFIX)
    );
    const tempReportPath = path.join(tempDir, 'report.json');

    try {
      const projectRoot = CodelinterAdapter.resolveProjectRoot(this.cwd);
      const lintTarget = this.resolveLintTarget(request.lintPath, projectRoot);
      const configPath = this.resolveConfigPath(request.configPath, lintTarget);
      const args = this.buildNativeArgs(
        request,
        lintTarget.path,
        configPath,
        tempReportPath
      );
      const result = await this.run(args);
      const extracted = extractJsonFromNativeStdout(result.stdout);
      const diagnostics =
        extracted.diagnostics + filterCodelinterNativeText(result.stderr);

      try {
        const rawJson = this.readJsonReport(tempReportPath, extracted.jsonText);
        return {
          exitCode: result.exitCode,
          diagnostics,
          report: createCodelinterReport(rawJson),
        };
      } catch (error) {
        return {
          exitCode: result.exitCode,
          diagnostics,
          reportError: error as Error,
        };
      }
    } finally {
      this.removeTempDir(tempDir);
    }
  }

  private resolveLintTarget(
    lintPath: string | undefined,
    projectRoot: string
  ): ResolvedLintTarget {
    const candidate = lintPath ? path.resolve(this.cwd, lintPath) : projectRoot;
    const resolved = this.resolveRealPath(candidate, 'Lint path');
    const stat = fs.statSync(resolved);
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`Lint path must be a file or directory: ${candidate}`);
    }
    const resolvedProjectRoot = this.discoverProjectRoot(
      resolved,
      stat.isDirectory()
    );
    if (lintPath !== undefined && resolvedProjectRoot === undefined) {
      throw new Error(
        'Lint path is not in a valid project directory ' +
          `(project-level build-profile.json5 not found or invalid): ${resolved}`
      );
    }
    return {
      path: resolved,
      projectRoot: resolvedProjectRoot,
    };
  }

  private resolveConfigPath(
    configPath: string | undefined,
    lintTarget: ResolvedLintTarget
  ): string {
    const candidate = configPath
      ? path.resolve(this.cwd, configPath)
      : path.join(lintTarget.projectRoot ?? this.cwd, 'code-linter.json5');
    const resolved = this.resolveRealPath(candidate, '`--config-path`');
    if (!fs.statSync(resolved).isFile()) {
      throw new Error(`--config-path must point to a file: ${candidate}`);
    }
    if (lintTarget.projectRoot) {
      const configProjectRoot = this.discoverProjectRoot(resolved, false);
      if (
        configProjectRoot === undefined ||
        path.relative(lintTarget.projectRoot, configProjectRoot) !== ''
      ) {
        throw new Error(
          '`--config-path` must belong to the same project as the lint path. ' +
            `Lint project: ${lintTarget.projectRoot}; ` +
            `Config project: ${configProjectRoot ?? 'not found'}.`
        );
      }
    }
    return resolved;
  }

  private discoverProjectRoot(
    targetPath: string,
    isDirectory: boolean
  ): string | undefined {
    const startDirectory = isDirectory ? targetPath : path.dirname(targetPath);
    try {
      return fs.realpathSync(Project.discover(startDirectory).rootDir);
    } catch {
      return undefined;
    }
  }

  private resolveRealPath(candidate: string, label: string): string {
    try {
      return fs.realpathSync(candidate);
    } catch (error) {
      throw new Error(
        `${label} does not exist or cannot be resolved: ${candidate}`,
        {
          cause: error,
        }
      );
    }
  }

  private buildNativeArgs(
    request: CodelinterCheckRequest,
    lintPath: string,
    configPath: string,
    outputPath: string
  ): string[] {
    const args = ['--config', configPath];
    if (request.fix) {
      args.push('--fix');
    }
    if (request.incremental) {
      args.push('--incremental');
    }
    args.push(
      '--product',
      request.product,
      '--format',
      'json',
      '--output',
      outputPath,
      lintPath
    );
    return args;
  }

  private async run(nativeArgs: string[]): Promise<CodelinterRunResult> {
    const args = [...this.resolution.argsPrefix, ...nativeArgs];
    const cwd = this.resolution.workingDirectory ?? this.cwd;
    this.prepareRuntimeDirectories();
    debugLog(`Executing: ${this.resolution.command} ${args.join(' ')}`);
    debugLog(`[CodelinterAdapter] Working directory: ${cwd}`);

    const result = await execa(this.resolution.command, args, {
      cwd,
      env: this.resolution.env,
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
    });

    return {
      exitCode: result.exitCode ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private prepareRuntimeDirectories(): void {
    for (const directory of this.resolution.runtimeDirectories ?? []) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  /** 优先读取报告文件，并兼容原生工具直接输出 JSON 的情况。 */
  private readJsonReport(
    reportPath: string,
    jsonText: string | undefined
  ): unknown {
    const fileContent = fs.existsSync(reportPath)
      ? fs.readFileSync(reportPath, 'utf-8').trim()
      : undefined;
    const content = fileContent || jsonText?.trim();

    if (!content) {
      throw new Error('Native JSON report was not generated.');
    }
    return JSON.parse(content) as unknown;
  }

  private removeTempDir(tempDir: string): void {
    const resolvedTempDir = path.resolve(tempDir);
    const resolvedOsTempDir = path.resolve(os.tmpdir());
    const insideOsTemp =
      resolvedTempDir.startsWith(`${resolvedOsTempDir}${path.sep}`) ||
      resolvedTempDir === resolvedOsTempDir;
    if (
      !insideOsTemp ||
      !path.basename(resolvedTempDir).startsWith(TEMP_DIRECTORY_PREFIX)
    ) {
      return;
    }
    fs.rmSync(resolvedTempDir, { recursive: true, force: true });
  }

  /** 根据 ToolProvider 解析 Code Linter 的完整执行环境。 */
  private static resolveWithToolProvider(
    toolProvider: ToolProvider
  ): CodelinterResolution {
    const source = CodelinterAdapter.getSource(toolProvider);
    const rootPath = toolProvider.toolchainRoot;
    const codelinterEntry = toolProvider.codelinterPath;
    const sdkPath = toolProvider.sdkPath;
    const pathEntries = CodelinterAdapter.getPathEntries(toolProvider, source);
    const displayName =
      source === 'ide' ? 'DevEco Studio' : 'DevEco Command Line Tools';

    const resolution: CodelinterResolution = {
      command: toolProvider.nodePath,
      argsPrefix: [codelinterEntry, sdkPath],
      env: {
        ...process.env,
        PATH: [...pathEntries, process.env.PATH || ''].join(path.delimiter),
        DEVECO_SDK_HOME: sdkPath,
      },
    };

    if (source === 'command-line-tools') {
      resolution.workingDirectory = rootPath;
      resolution.runtimeDirectories = [
        CodelinterAdapter.getResultDirectory(codelinterEntry),
      ];
    }

    debugLog(
      `[CodelinterAdapter] Selected ${displayName} entry: ${codelinterEntry}`
    );
    return resolution;
  }

  /** 构造 Code Linter 子进程所需的 PATH 目录。 */
  private static getPathEntries(
    toolProvider: ToolProvider,
    source: CodelinterToolchainSource
  ): string[] {
    const entries = [path.dirname(toolProvider.nodePath)];
    if (source === 'ide' && toolProvider.javaPath) {
      entries.unshift(path.dirname(toolProvider.javaPath));
    }
    return entries;
  }

  /** 解析 Command Line Tools 链路所需的结果目录。 */
  private static getResultDirectory(codelinterEntry: string): string {
    return path.resolve(codelinterEntry, '..', 'linter', 'result');
  }

  /** 将 ToolProvider 来源映射为 Code Linter 工具链来源。 */
  private static getSource(
    toolProvider: ToolProvider
  ): CodelinterToolchainSource {
    return toolProvider.sourceType === 'studio' ? 'ide' : 'command-line-tools';
  }
}
