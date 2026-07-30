/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { ToolProvider } from '../toolchain/index.js';
import {
  clangdPathFromSdk,
  findDevEcoPath,
  findHarmonyProjectInDir,
  normalizePath,
  resolveSdkPath,
  compileCommandsPath,
} from '../../mcp/src-server/utils/common.js';
import { toUnixPath } from '../../mcp/src-server/lsp/utils.js';
import { initMcpLogger, mcpLog } from '../../mcp/src-server/utils/mcp-logger.js';

export interface CppLspOptions {
  projectPath?: string;
  /** 未指定 --project-path 时，开启后从 cwd 及其子目录向下查找工程根（不向上搜索）。 */
  autoDetect?: boolean;
}

/**
 * 仅负责拉起 clangd 子进程，并在父进程 stdin/stdout 与子进程之间建立透明字节桥接。
 * clangd 路径 / compile_commands 目录完全由本命令自行解析（不由用户传入），
 * initialize / initialized 等握手流程由连接到本命令的 LSP 客户端（编辑器）自行驱动，本命令不参与。
 *
 * 前置条件：工程需已执行过 `devecocli build` 以生成 compile_commands.json。
 * 若该文件不存在，clangd 仍能启动但仅提供语法级诊断，跨文件导航/补全能力受限。
 */
export async function startClangdLspServer(options: CppLspOptions): Promise<void> {
  initMcpLogger(false);

  const { clangdPath, compileCommandsDir, projectPath } =
    await resolvePaths(options);

  // 检测 compile_commands.json 是否存在
  const ccFile = path.join(compileCommandsDir, 'compile_commands.json');
  if (!fs.existsSync(ccFile)) {
    mcpLog.warn(
      `compile_commands.json not found at ${ccFile}. ` +
        'Cross-file navigation/completion will be limited. ' +
        'Run `devecocli build` first to generate it.',
    );
  }

  const child = spawnClangd(clangdPath, compileCommandsDir, projectPath);

  mcpLog.info(
    'clangd started, bridging stdio (initialize is left to the client)',
  );
  setupBridge(child);
}

async function resolvePaths(options: CppLspOptions): Promise<{
  projectPath: string;
  clangdPath: string;
  compileCommandsDir: string;
}> {
  const devecoPath = await resolveDevecoPath();
  if (!devecoPath) {
    mcpLog.error('DevEco Studio not found. Ensure DevEco Studio is installed.');
    process.exit(1);
  }

  // 指定路径→直接用（不搜，安全）；未指定+--auto-detect→从 cwd 向下搜（不向上）；否则用 cwd。
  let projectPath: string;
  if (options.projectPath) {
    projectPath = normalizePath(path.resolve(options.projectPath));
    mcpLog.info(`projectPath=specified ('${projectPath}'), no search`);
  } else if (options.autoDetect) {
    const found = findHarmonyProjectInDir(process.cwd());
    projectPath = normalizePath(found ?? process.cwd());
    mcpLog.info(`findHarmonyProjectInDir('${process.cwd()}') => ${found ?? 'null, fallback to cwd'}`);
  } else {
    projectPath = normalizePath(path.resolve(process.cwd()));
    mcpLog.info(`projectPath=cwd ('${projectPath}'), no search (pass --auto-detect to search subdirs)`);
  }
  // 启动期固定 sdkPath（env 优先，否则按 CLT|Studio 布局派生），clangd 从 sdkPath 派生。
  const sdkPath = resolveSdkPath(devecoPath);
  const clangdPath = clangdPathFromSdk(sdkPath);
  if (!clangdPath) {
    mcpLog.error(
      `clangd not found under sdk '${sdkPath}'. ` +
        'Expected at <sdkPath>/default/openharmony/native/llvm/bin/clangd',
    );
    process.exit(1);
  }

  // compile_commands.json 所在目录（<project>/.idea/.deveco/cxx）
  const ccPath = compileCommandsPath(projectPath);
  const compileCommandsDir = path.dirname(ccPath);

  mcpLog.info(
    `projectPath=${projectPath}, sdkPath=${sdkPath}, clangdPath=${clangdPath}, compileCommandsDir=${compileCommandsDir}`,
  );
  return { projectPath, clangdPath, compileCommandsDir };
}

function resolveDevecoPath(): Promise<string | null> {
  return ToolProvider.new()
    .then((tp) => tp.devecoStudioPath)
    .catch(() => findDevEcoPath());
}

function spawnClangd(
  clangdPath: string,
  compileCommandsDir: string,
  projectPath: string,
): ChildProcess {
  const args = buildSpawnArgs(compileCommandsDir);
  mcpLog.info(`[serve-lsp-cpp] spawn: ${clangdPath} ${args.join(' ')}`);
  return spawn(clangdPath, args, {
    cwd: projectPath,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function buildSpawnArgs(compileCommandsDir: string): string[] {
  const ccDir = toUnixPath(compileCommandsDir);
  return [
    `--compile-commands-dir=${ccDir}`,
    '--log=info',
    '--pch-storage=memory',
  ];
}

/**
 * 透明字节桥接：子进程 stdout → 父进程 stdout；父进程 stdin → 子进程 stdin。
 * 不解析、不拦截任何 LSP 消息（包括 initialize / initialized）。
 */
function setupBridge(child: ChildProcess): void {
  child.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on('data', (chunk: Buffer) => {
    mcpLog.error(`[clangd] ${chunk.toString('utf8').trim()}`);
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
    mcpLog.info(`clangd exited with code ${code}`);
    process.exit(code ?? 0);
  });
}
