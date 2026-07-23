/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { createMcpServer } from '../../mcp/src-server/index.js';
import { ToolProvider } from '../toolchain/index.js';
import { startArktsLspServer } from './serve-lsp.js';
import { startClangdLspServer } from './serve-lsp-cpp.js';

/**
 * 启动 stdio 模式的 MCP server，并接管当前进程的 stdin/stdout 作为通信通道。
 */
async function startStdioMcpServer(): Promise<void> {
  const PROJECT_PATH = process.env.PROJECT_PATH || '';
  const NODE_MAX_OLD_SPACE_SIZE = process.env.NODE_MAX_OLD_SPACE_SIZE;
  const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
  const toolProvider = await ToolProvider.new();
  toolProvider.require({ clt: false });
  const projectPath = PROJECT_PATH;
  const devecoPath = toolProvider.devecoStudioPath;

  const server = createMcpServer({
    projectPath,
    devecoPath,
    nodeMaxOldSpaceSize: NODE_MAX_OLD_SPACE_SIZE,
    debug: DEBUG,
  });

  const shutdown = async (): Promise<void> => {
    await server.shutdown();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (process.platform === 'win32') {
    process.once('SIGBREAK', shutdown);
  }

  try {
    await server.start();
  } catch (err) {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  }
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
  .option('--project-path <path>', 'HarmonyOS project root path', process.cwd())
  .action(async (options) => {
    if (options.arkts && options.cpp) {
      console.error('--arkts and --cpp are mutually exclusive. Specify only one.');
      process.exit(1);
    }
    if (options.arkts) {
      await startArktsLspServer({
        projectPath: options.projectPath,
      });
    } else if (options.cpp) {
      await startClangdLspServer({
        projectPath: options.projectPath,
      });
    } else {
      console.error('Use --arkts or --cpp to specify which language server to start.');
      process.exit(1);
    }
  });

export default serveCommand;
