/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as path from 'path';
import { z } from 'zod';
import { ToolRouter, createToolRouter } from './router.js';
import { ArktsCheckTool, CppCheckTool } from './tools/index.js';
import { findHarmonyProject, isSupportedCppFile } from './utils/common.js';
import { initMcpLogger, disposeMcpLogger, flushMcpLogger, getMcpLogFilePath, mcpLog } from './utils/mcp-logger.js';

/**
 * MCP Server Configuration
 */
export interface McpServerConfig {
  projectPath?: string;
  devecoPath?: string;
  nodeMaxOldSpaceSize?: string;
  /** debug 模式：true=console输出，false=文件输出（带轮转） */
  debug?: boolean;
}

/**
 * MCP Server
 */
export class CodegenieMcpServer {
  private server: McpServer;
  private toolRouter: ToolRouter;
  private config: McpServerConfig = {};

  // Tool instances
  private arktsCheckTool: ArktsCheckTool | null = null;
  private cppCheckTool: CppCheckTool | null = null;

  constructor(config: McpServerConfig = {}) {
    this.config = config;
    
    // 初始化 Logger（根据 debug 配置决定输出方式）
    initMcpLogger(config.debug ?? false);
    
    this.config.projectPath = findHarmonyProject(config.projectPath ?? '') ?? undefined;
    
    // Create MCP server instance
    this.server = new McpServer({
      name: 'codegenie-mcp-server',
      version: '0.0.1',
    });

    // Create tool router
    this.toolRouter = createToolRouter();

    // Register tools
    this.registerTools();
  }

  /**
   * Register all tools to the router.
   *
   * 目前只暴露一个 `check` 工具：根据传入文件的扩展名自动分发——
   *  - `.ets` → ArkTS LSP（{@link ArktsCheckTool}）
   *  - `.c/.cc/.cpp/.cxx/.h/.hh/.hpp/...` → clangd（{@link CppCheckTool}）
   *  - 其它扩展名 → 收集为错误返回。
   */
  private registerTools(): void {
    this.toolRouter.add(
      {
        name: 'check',
        description:
          '对传入的 ArkTS (.ets) 或 C/C++ 文件进行静态语法检查并返回诊断信息。' +
          '工具会根据文件扩展名自动选择检查器：.ets 走 ArkTS-Check，' +
          '.c/.cc/.cpp/.cxx/.h/.hh/.hpp/.hxx 等走 clangd。',
        inputSchema: z.object({
          files: z
            .array(z.string())
            .describe(
              '待检查的文件路径列表，可同时包含 ArkTS (.ets) 和 C/C++ 文件，' +
                '格式为 ["src/main.ets","native/foo.cpp",...]'
            ),
        }),
      },
      async (args: Record<string, unknown>) => this.handleCheckCall(args)
    );
  }

  /**
   * `check` 工具的统一入口：按文件扩展名分桶，分别调对应 LSP 工具，再合并结果。
   */
  private async handleCheckCall(
    args: Record<string, unknown>
  ): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const files = Array.isArray((args as { files?: unknown }).files)
      ? ((args as { files: unknown[] }).files.filter(
          (f): f is string => typeof f === 'string'
        ))
      : [];
    if (files.length === 0) {
      return {
        content: [{ type: 'text', text: '没有传入任何文件' }],
        isError: true,
      };
    }

    const { etsFiles, cppFiles, unsupported } = classifyFiles(files);

    const errors: string[] = unsupported.map(
      (f) => `不支持的文件类型: ${f}（仅支持 .ets 与 C/C++ 源/头文件）`
    );
    const infos: string[] = [];

    if (etsFiles.length > 0) {
      this.mergeCheckResult(await this.callArktsCheck(etsFiles), errors, infos);
    }
    if (cppFiles.length > 0) {
      this.mergeCheckResult(await this.callCppCheck(cppFiles), errors, infos);
    }

    const isError = errors.length > 0;
    const text = [infos.join('\n'), errors.join('\n')]
      .filter((part) => part.trim().length > 0)
      .join('\n')
      .trim();
    return {
      content: [{ type: 'text', text: text || '未收集到诊断信息' }],
      isError,
    };
  }

  /** 调 ArkTS 工具；未就绪时返回统一错误。 */
  private async callArktsCheck(files: string[]): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    if (!this.arktsCheckTool || !this.arktsCheckTool.isInitialized()) {
      const msg = this.arktsCheckTool?.isInitializing()
        ? 'ArkTS LSP 正在初始化中，请稍后再试'
        : !this.config.projectPath
          ? '没有配置工程路径，请配置PROJECT_PATH参数或者在DevEco Studio中打开项目'
          : 'ArkTS LSP 未初始化，请尝试重新初始化';
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
    return this.arktsCheckTool.handleCall({ files });
  }

  /** 调 C/C++ 工具；未就绪时返回统一错误。 */
  private async callCppCheck(files: string[]): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    if (!this.cppCheckTool) {
      const msg = this.config.projectPath
        ? 'C++ LSP 未就绪，请稍后重试'
        : '没有配置工程路径，请配置PROJECT_PATH参数或者在DevEco Studio中打开项目';
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
    return this.cppCheckTool.handleCall({ files });
  }

  /** 把单个子 handler 的返回合并到 errors / infos 池。 */
  private mergeCheckResult(
    result: { content: { type: string; text: string }[]; isError?: boolean },
    errors: string[],
    infos: string[]
  ): void {
    const text = result.content
      .map((c) => c.text)
      .filter((t) => t && t.trim().length > 0)
      .join('\n');
    if (!text) {
      return;
    }
    if (result.isError) {
      errors.push(text);
    } else {
      infos.push(text);
    }
  }

  /**
   * Update project path
   */
  setProjectPath(projectPath: string): void {
    this.config.projectPath = projectPath;
    process.env.PROJECT_PATH = projectPath;

    // Reset ArktsCheckTool if project path changes
    if (this.arktsCheckTool) {
      this.arktsCheckTool.shutdown().catch(() => {});
      this.arktsCheckTool = null;
    }
    // Reset CppCheckTool if project path changes
    if (this.cppCheckTool) {
      this.cppCheckTool.shutdown().catch(() => {});
      this.cppCheckTool = null;
    }
  }

  /**
   * Start the MCP server with stdio transport
   */
  async start(): Promise<void> {
    // Register tools to server
    this.toolRouter.registerToServer(this.server);

    // Connect with stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    mcpLog.info('codegenie-mcp-server started');
    
    // 非 debug 模式下，打印日志文件路径
    if (!this.config.debug) {
      const logPath = getMcpLogFilePath();
      if (logPath) {
        mcpLog.info(`Log file: ${logPath}`);
      }
    }

    // Initialize ArktsCheckTool LSP (best-effort)
    await this.initializeArktsCheck();

    // CppCheckTool 采用懒加载：仅在 projectPath 已配置时构造，clangd 首次调用时才 spawn。
    this.initializeCppCheck();
  }

  /**
   * 构造 CppCheckTool（懒初始化模式）：
   * - 仅在 projectPath 配置时构造；
   * - 真正的 clangd 进程在第一次工具调用（`handleCall`）时由 `ensureInitialized()` spawn。
   */
  private initializeCppCheck(): void {
    const projectPath = this.config.projectPath;
    if (!projectPath) {
      mcpLog.warn('C++ LSP initialization skipped: project path is not configured');
      return;
    }
    this.cppCheckTool = new CppCheckTool(
      projectPath,
      this.config.devecoPath ?? null
    );
    mcpLog.info('CppCheckTool created (lazy initialization)');
  }

  /**
   * Initialize ArktsCheckTool LSP client.
   */
  private async initializeArktsCheck(): Promise<void> {
    const projectPath = this.config.projectPath;
    if (!projectPath) {
      mcpLog.warn('LSP initialization skipped: project path is not configured');
      return;
    }

    mcpLog.info('Initializing ArkTS LSP...');

    this.arktsCheckTool = new ArktsCheckTool(
      projectPath,
      this.config.devecoPath ?? null,
      this.config.nodeMaxOldSpaceSize
    );

    try {
      await this.arktsCheckTool.initialize();
      mcpLog.info('ArkTS LSP initialized successfully');
    } catch (err) {
      mcpLog.error('ArkTS LSP initialization failed:', err);
      this.arktsCheckTool = null;
    }
  }

  /**
   * Shutdown the server
   */
  async shutdown(): Promise<void> {
    if (this.arktsCheckTool) {
      await this.arktsCheckTool.shutdown();
    }
    if (this.cppCheckTool) {
      await this.cppCheckTool.shutdown();
    }
    mcpLog.info('codegenie-mcp-server stopped');
    flushMcpLogger();
    disposeMcpLogger();
  }

  /**
   * Get the tool router
   */
  getToolRouter(): ToolRouter {
    return this.toolRouter;
  }

  /**
   * Get the MCP server instance
   */
  getServer(): McpServer {
    return this.server;
  }
}

/**
 * 把入参里的文件按扩展名分桶。注意：这里只做扩展名判断，
 * 不做"文件是否存在 / 是否是普通文件"等检查——这些由各自的 LSP 工具自身负责。
 */
function classifyFiles(files: string[]): {
  etsFiles: string[];
  cppFiles: string[];
  unsupported: string[];
} {
  const etsFiles: string[] = [];
  const cppFiles: string[] = [];
  const unsupported: string[] = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.ets') {
      etsFiles.push(file);
    } else if (isSupportedCppFile(file)) {
      cppFiles.push(file);
    } else {
      unsupported.push(file);
    }
  }
  return { etsFiles, cppFiles, unsupported };
}

/**
 * Create a new MCP server
 */
export function createMcpServer(config: McpServerConfig = {}): CodegenieMcpServer {
  return new CodegenieMcpServer(config);
}