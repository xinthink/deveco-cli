/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { createMcpServer } from '../../mcp/src-server/index.js';
import { ToolProvider } from '../toolchain/index.js';
import { telemetry } from '../trace/index.js';
import { startArktsLspServer } from './serve-lsp.js';
import { startClangdLspServer } from './serve-lsp-cpp.js';

/**
 * 启动 stdio 模式的 MCP server，并接管当前进程的 stdin/stdout 作为通信通道。
 */
async function startStdioMcpServer(): Promise<void> {
  const PROJECT_PATH = process.env.PROJECT_PATH || '';
  const NODE_MAX_OLD_SPACE_SIZE = process.env.NODE_MAX_OLD_SPACE_SIZE;
  const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
  // ToolProvider 优先用 DevEco Studio/CLT 安装；缺失时若设置了 DEVECO_CLI_SDK_PATH /
  // DEVECO_CLI_ARKTS_LSP_PATH 则以最小配置启动（sdk/arkts-lsp 由 MCP 内部按环境变量派生）。
  const projectPath = PROJECT_PATH;
  const toolProvider = await ToolProvider.new();
  const devecoPath =
    toolProvider.sourceType === 'clt'
      ? toolProvider.toolchainRoot
      : (toolProvider.devecoStudioPath ?? null);

  const server = createMcpServer({
    projectPath,
    devecoPath: devecoPath ?? undefined,
    nodeMaxOldSpaceSize: NODE_MAX_OLD_SPACE_SIZE,
    debug: DEBUG,
    telemetry,
  });

  // server.start() resolves immediately (fire-and-forget via StdioTransport).
  // Block here until a shutdown signal so the caller (parseAsync) doesn't
  // resolve prematurely — otherwise cli.ts stops the telemetry scheduler
  // before the first flush ever runs.
  let resolveShutdown!: () => void;
  const shutdownSignal = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const shutdown = async (): Promise<void> => {
    await server.shutdown();
    resolveShutdown();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (process.platform === 'win32') {
    process.once('SIGBREAK', shutdown);
  }

  try {
    await server.start();
  } catch (err) {
    console.error('Failed to start MCP server:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  await shutdownSignal;
}

const serveCommand = new Command('serve').description(
  'Host bundled auxiliary protocol servers'
);

serveCommand
  .command('mcp')
  .description('Start a local stdio-based MCP server')
  .action(async () => {
    await startStdioMcpServer();
  });

serveCommand
  .command('lsp')
  .description('Start a bundled LSP language server')
  .option('--arkts', 'Start the ArkTS language server (ace-server)')
  .option('--cpp', 'Start the C/C++ language server (clangd)')
  .option('--project-path <path>', 'project root path (used as-is, no search)')
  .option('--auto-detect', 'When --project-path is not specified, search the current directory and its subdirectories for the project root (no upward search)')
  .action(async (options) => {
    if (options.arkts && options.cpp) {
      console.error('--arkts and --cpp are mutually exclusive. Specify only one.');
      process.exit(1);
    }
    if (options.arkts) {
      await startArktsLspServer({
        projectPath: options.projectPath,
        autoDetect: options.autoDetect,
      });
    } else if (options.cpp) {
      await startClangdLspServer({
        projectPath: options.projectPath,
        autoDetect: options.autoDetect,
      });
    } else {
      console.error('Use --arkts or --cpp to specify which language server to start.');
      process.exit(1);
    }
  });

export default serveCommand;
