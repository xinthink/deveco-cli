/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { ToolProvider } from '../utils/tool-provider.js';
import {
  findArktsLangServerPath,
  findDevEcoPath,
  getMcpLogDirectory,
  normalizePath,
  devecoStudioContentRoot,
} from '../../mcp/src-server/utils/common.js';
import { computeLspServerMaxSize, toUnixPath } from '../../mcp/src-server/lsp/utils.js';
import { ModulesDependencyParse } from '../../mcp/src-server/lsp/parse/ModulesDependencyParse.js';
import { ModuleInfoParse } from '../../mcp/src-server/lsp/parse/ModuleInfoParse.js';
import type { ModuleModel } from '../../mcp/src-server/lsp/model/ModuleModel.js';
import { DependencyMapParseStatus } from '../../mcp/src-server/lsp/constant.js';
import { initMcpLogger, mcpLog } from '../../mcp/src-server/utils/mcp-logger.js';

export interface ArktsLspOptions {
  projectPath?: string;
}

/**
 * 仅负责拉起 ArkTS LSP (ace-server) 子进程，并在父进程 stdin/stdout 与子进程
 * 之间建立透明字节桥接。--projectPath / --sdkPath 完全由本命令自行解析（不由
 * 用户传入），initialize / initialized 等握手流程由连接到本命令的 LSP 客户端
 * （编辑器）自行驱动，本命令不参与。
 */
export async function startArktsLspServer(options: ArktsLspOptions): Promise<void> {
  initMcpLogger(false);

  const { serverPath, logPath, projectPath, sdkPath, serverMaxSize } = await resolvePaths(options);
  const child = spawnAceServer(serverPath, logPath, projectPath, sdkPath, serverMaxSize);

  mcpLog.info('ace-server started, bridging stdio (initialize is left to the client)');
  setupBridge(child);
}

async function resolvePaths(options: ArktsLspOptions): Promise<{
  projectPath: string;
  sdkPath: string;
  serverPath: string;
  logPath: string;
  serverMaxSize: number;
}> {
  const devecoPath = await resolveDevecoPath();
  if (!devecoPath) {
    mcpLog.error('DevEco Studio not found. Ensure DevEco Studio is installed.');
    process.exit(1);
  }

  const projectPath = normalizePath(options.projectPath ?? process.cwd());
  const sdkPath = path.join(devecoStudioContentRoot(devecoPath), 'sdk');
  const arktsLangServerPath = findArktsLangServerPath(devecoPath);
  if (!arktsLangServerPath) {
    mcpLog.error('ace-server not found in DevEco Studio installation.');
    process.exit(1);
  }
  const serverPath = path.resolve(arktsLangServerPath, 'ace-server', 'out', 'standardIndex', 'index.js');
  const logPath = path.join(getMcpLogDirectory(), 'lsp-server', String(Date.now()));
  fs.mkdirSync(logPath, { recursive: true });
  const serverMaxSize = resolveServerMaxSize(projectPath, sdkPath);

  mcpLog.info(`projectPath=${projectPath}, sdkPath=${sdkPath}, serverPath=${serverPath}, logPath=${logPath}, serverMaxSize=${serverMaxSize}MB`);
  return { projectPath, sdkPath, serverPath, logPath, serverMaxSize };
}

function resolveDevecoPath(): Promise<string | null> {
  return ToolProvider.new()
    .then((tp) => tp.devecoStudioPath)
    .catch(() => findDevEcoPath());
}

/**
 * 动态计算 ace-server 进程的 --max-old-space-size（单位 MB），规则与 `serve mcp` 路径一致。
 * 优先用 `.hvigor/dependencyMap` 解析的模块数（需已 sync）；失败则回退到 `build-profile.json5`
 * 的模块数；`NODE_MAX_OLD_SPACE_SIZE` 环境变量可显式 override，仍受物理内存 70% 上限约束。
 */
function resolveServerMaxSize(projectPath: string, sdkPath: string): number {
  const overrideRaw = process.env.NODE_MAX_OLD_SPACE_SIZE;
  const overrideParsed = overrideRaw ? parseInt(overrideRaw, 10) : NaN;
  const overrideSize = Number.isFinite(overrideParsed) && overrideParsed > 0 ? overrideParsed : undefined;

  const moduleCount = resolveModuleCount(projectPath, sdkPath);
  const size = computeLspServerMaxSize(moduleCount, overrideSize);
  mcpLog.info(`[serve-lsp] serverMaxSize=${size}MB (moduleCount=${moduleCount}, override=${overrideSize ?? 'none'})`);
  return size;
}

function resolveModuleCount(projectPath: string, sdkPath: string): number {
  try {
    const moduleModels: ModuleModel[] = [];
    const parser = new ModulesDependencyParse(projectPath, sdkPath);
    const result = parser.getAllDependencyMap(moduleModels);
    if (result.status === DependencyMapParseStatus.OK) {
      return moduleModels.length;
    }
    return new ModuleInfoParse(projectPath).getAllModuleInfo().length;
  } catch {
    return 0;
  }
}

function spawnAceServer(
  serverPath: string,
  logPath: string,
  projectPath: string,
  sdkPath: string,
  serverMaxSize: number,
): ChildProcess {
  const lspLogPath = path.join(logPath, 'lspLog');
  fs.mkdirSync(lspLogPath, { recursive: true });
  const args = buildSpawnArgs(serverPath, lspLogPath, projectPath, sdkPath, serverMaxSize);
  const nodePath = process.execPath ?? 'node';
  mcpLog.info(`[serve-lsp] spawn: ${nodePath} ${args.join(' ')}`);
  return spawn(nodePath, args, {
    cwd: projectPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function buildSpawnArgs(
  serverPath: string,
  lspLogPath: string,
  projectPath: string,
  sdkPath: string,
  serverMaxSize: number,
): string[] {
  const lspPathStr = toUnixPath(lspLogPath);
  return [
    '--expose-gc',
    `--max-old-space-size=${serverMaxSize}`,
    '--report-on-fatalerror',
    '--report-uncaught-exception',
    `--report-filename=nodejs_error_${Date.now()}.txt`,
    `--report-dir=${lspPathStr}`,
    serverPath,
    '--stdio',
    `--logger-path=${lspPathStr}`,
    '--logger-level=TRACE',
    `--projectPath=${toUnixPath(projectPath)}`,
    `--sdkPath=${toUnixPath(sdkPath)}`,
  ];
}

/**
 * 透明字节桥接：子进程 stdout → 父进程 stdout；父进程 stdin → 子进程 stdin。
 * 不解析、不拦截任何 LSP 消息（包括 initialize / initialized）。
 */
function setupBridge(child: ChildProcess): void {
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => {
    mcpLog.error(`[ace-server] ${chunk.toString('utf8').trim()}`);
  });
  process.stdin.on('data', (chunk: Buffer) => {
    child.stdin?.write(chunk);
  });
  process.stdin.on('end', () => {
    mcpLog.info('Editor disconnected, shutting down');
    child.kill();
    process.exit(0);
  });
  child.on('exit', (code) => {
    mcpLog.info(`ace-server exited with code ${code}`);
    process.exit(code ?? 0);
  });
}
