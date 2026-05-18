#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { createMcpServer } from '../mcp/src-server/index.js';
import { ToolProvider } from './utils/tool-provider.js';

// Environment variables configuration
const PROJECT_PATH = process.env.PROJECT_PATH || '';
const DEVECO_PATH = process.env.DEVECO_PATH;
const NODE_MAX_OLD_SPACE_SIZE = process.env.NODE_MAX_OLD_SPACE_SIZE || '8192';
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';

/**
 * Main entry point - MCP server mode only
 */
async function main(): Promise<void> {
  const toolProvider = await ToolProvider.new();
  const projectPath = PROJECT_PATH;
  const devecoPath = DEVECO_PATH ?? toolProvider.devecoStudioPath;

  // Create MCP server
  const server = createMcpServer({
    projectPath,
    devecoPath,
    nodeMaxOldSpaceSize: NODE_MAX_OLD_SPACE_SIZE,
    debug: DEBUG,
  });

  // Handle shutdown signals
  const shutdown = async () => {
    await server.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (process.platform === 'win32') {
    process.on('SIGBREAK', shutdown);
  }

  // Start server
  try {
    await server.start();
  } catch (err) {
    console.error('Failed to start MCP server:', err);
    process.exit(1);
  }
}

// Run main
main().catch((err) => {
  console.error(err);
  process.exit(1);
});