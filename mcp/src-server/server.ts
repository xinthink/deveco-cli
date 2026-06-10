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
import { findHarmonyProject, isSupportedCppFile, smartFindToolPath, devecoStudioContentRoot } from './utils/common.js';
import { CommonUtils } from '../../src/utils/common-utils.js';
import { initMcpLogger, disposeMcpLogger, flushMcpLogger, getMcpLogFilePath, mcpLog } from './utils/mcp-logger.js';
import { ArktsLspManager } from './lsp/ArktsLspManager.js';
import { checkSyncRequired } from './lsp/sync/syncGuard.js';

/**
 * 项目生命周期状态枚举
 */
enum ProjectLifecycle {
  IDLE,         // 无项目（空文件夹 / 启动时未检测到）
  DISCOVERING,  // 正在扫描/检测项目
  SYNCING,      // 项目已发现，正在执行 ohpm install + hvigor sync
  INITIALIZING, // sync 完成，LSP 正在初始化
  READY,        // 完全就绪，check 工具可用
  ERROR,        // sync 或 init 失败，可重试
}

const MAX_INIT_RETRY = 3;
const SYNC_SKIP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * MCP Server Configuration
 */
export interface McpServerConfig {
  projectPath?: string;
  devecoPath?: string;
  nodeMaxOldSpaceSize?: string;
  /** debug 模式：true=console输出，false=文件输出（带轮转） */
  debug?: boolean;
  /** 强制每次启动都执行 sync（来自环境变量 DEVECO_MCP_FORCE_SYNC） */
  forceSync?: boolean;
}

/**
 * MCP Server
 */
export class DevecoCliMcpServer {
  private server: McpServer;
  private toolRouter: ToolRouter;
  private config: McpServerConfig = {};

  // Tool instances
  private arktsCheckTool: ArktsCheckTool | null = null;
  private cppCheckTool: CppCheckTool | null = null;

  // 项目生命周期状态
  private projectState: ProjectLifecycle = ProjectLifecycle.IDLE;
  private workspaceRoot: string = '';       // MCP 客户端提供的 workspace root，供重新扫描
  private sdkPath: string = '';             // 缓存 sdkPath，避免重复计算
  private initPromise: Promise<void> | null = null;  // 互斥锁：保证同一时刻只有一个初始化流程在执行
  private needsReinit: boolean = false;     // 路径变更标记：初始化运行期间 setProjectPath() 被调用时设置
  private initRetryCount: number = 0;       // 连续初始化失败计数，超过 MAX_INIT_RETRY 后不再自动重试
  private originalProjectPath: string = ''; // 用户原始配置的路径（findHarmonyProject 解析前），用于区分"未设置"与"设置了但未找到鸿蒙工程"
  private configChangedTriggeredResync: boolean = false;  // 配置文件变化触发的重新同步标记，用于区分提示消息
  private syncSkippedDueToLock: boolean = false;  // sync 因锁被占用而跳过，用于返回更精确的提示消息
  private syncSkipStartedAt: number = 0;          // 首次因锁竞争跳过 sync 的时间戳，超过 SYNC_SKIP_TIMEOUT_MS 后进入 ERROR 状态

  constructor(config: McpServerConfig = {}) {
    this.config = config;
    
    // 初始化 Logger（根据 debug 配置决定输出方式）
    initMcpLogger(config.debug ?? false);
    
    // 处理 projectPath：
    let startPath: string;
    const configuredPath = config.projectPath?.trim() ?? '';
    this.originalProjectPath = configuredPath;
    if (configuredPath === '.') {
      startPath = process.cwd();
      mcpLog.info(`Constructor: configuredPath is '.', startPath: '${startPath}'`);
    } else if (configuredPath === '') {
      startPath = '';
      mcpLog.info(`Constructor: configuredPath is empty, startPath remains empty`);
    } else {
      startPath = configuredPath;
      mcpLog.info(`Constructor: using configured path as startPath: '${startPath}'`);
    }
    const foundProject = findHarmonyProject(startPath);
    mcpLog.info(`Constructor: findHarmonyProject('${startPath}') => ${foundProject ?? 'null'}`);
    this.config.projectPath = foundProject ?? undefined;
    
    // Create MCP server instance
    this.server = new McpServer({
      name: 'devecocli-mcp-server',
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
          'Perform static syntax analysis on HarmonyOS project source files and return structured diagnostics. ' +
          'Supported languages: ArkTS and C/C++.',
        inputSchema: z.object({
          files: z
            .array(z.string())
            .min(1)
            .describe(
              'List of source file paths to check, relative to the project root. ' +
                'Supports ArkTS and C/C++ files in the same call.'
            ),
        }),
      },
      async (args: Record<string, unknown>) => this.handleCheckCall(args)
    );
  }

  /**
   * 路径 containment 校验：
   * - 有 projectPath 时：对每个文件做 isPathContained 检查
   * - 无 projectPath 时：仅拒绝绝对路径
   * 通过返回 null，失败返回错误响应。
   */
  private validateContainment(
    files: string[]
  ): { content: { type: string; text: string }[]; isError: boolean } | null {
    const projectPath = this.config.projectPath;
    if (projectPath) {
      const containmentErrors: string[] = [];
      for (const file of files) {
        const result = CommonUtils.isPathContainedWithSymlink(file, projectPath);
        if (!result.contained) {
          mcpLog.warn(`Containment check failed: ${result.reason}`);
          containmentErrors.push(result.reason!);
        }
      }
      if (containmentErrors.length > 0) {
        return {
          content: [{ type: 'text', text: containmentErrors.join('\n') }],
          isError: true,
        };
      }
      return null;
    }
    const absolutePaths = files.filter((f) => path.isAbsolute(f));
    if (absolutePaths.length > 0) {
      mcpLog.warn(`Absolute paths rejected (no project root): ${absolutePaths.join(', ')}`);
      return {
        content: [{ type: 'text', text: absolutePaths.map((f) => `Absolute path is not allowed: ${f}`).join('\n') }],
        isError: true,
      };
    }
    return null;
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
      mcpLog.warn('check tool called with empty files list');
      return {
        content: [{ type: 'text', text: 'No files provided' }],
        isError: true,
      };
    }

    const containmentResult = this.validateContainment(files);
    if (containmentResult) {
      return containmentResult;
    }

    const { etsFiles, cppFiles, unsupported } = classifyFiles(files);
    if (unsupported.length > 0) {
      mcpLog.warn(`Unsupported file types in check request: ${unsupported.join(', ')}`);
    }

    const errors: string[] = unsupported.map(
      (f) => `Unsupported file type: ${f} (only .ets and C/C++ source/header files are supported)`
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
      content: [{ type: 'text', text: text || 'No diagnostics collected' }],
      isError,
    };
  }

  /** 调 ArkTS 工具；按项目生命周期状态分流。 */
  private async callArktsCheck(files: string[]): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    switch (this.projectState) {
      case ProjectLifecycle.IDLE:
        return this.handleIdleCheck();
      case ProjectLifecycle.DISCOVERING:
      case ProjectLifecycle.SYNCING:
        mcpLog.warn(`ArkTS check rejected: project is ${ProjectLifecycle[this.projectState]}, files: ${files.join(', ')}`);
        return { content: [{ type: 'text', text: 'Project is syncing, please retry in 10 seconds' }], isError: true };
      case ProjectLifecycle.INITIALIZING:
        mcpLog.warn(`ArkTS check rejected: LSP is initializing, files: ${files.join(', ')}`);
        return { content: [{ type: 'text', text: 'ArkTS LSP is initializing, please retry in 10 seconds' }], isError: true };
      case ProjectLifecycle.ERROR:
        return this.handleErrorCheck();
      case ProjectLifecycle.READY:
        return this.arktsCheckTool!.handleCall({ files });
    }
  }

  /** IDLE 状态下检查：触发 ensureProjectReady（项目搜索由 Phase 1 统一处理），
   *  根据当前已有信息判断返回消息。
   */
  private async handleIdleCheck(): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    this.ensureProjectReady();
    if (this.config.projectPath) {
      let msg: string;
      let trigger: string;
      if (this.syncSkippedDueToLock) {
        const elapsedSec = this.syncSkipStartedAt > 0 ? Math.round((Date.now() - this.syncSkipStartedAt) / 1000) : 0;
        msg = `Another build process is running, sync deferred (waiting ${elapsedSec}s), please retry in 25 seconds`;
        trigger = 'lock contention';
        this.syncSkippedDueToLock = false;
      } else if (this.configChangedTriggeredResync) {
        msg = 'Config file changed, resyncing project, please retry in 10 seconds';
        trigger = 'config changed';
        this.configChangedTriggeredResync = false;
      } else {
        msg = 'HarmonyOS project detected, syncing, please retry in 10 seconds';
        trigger = 'initial';
      }
      mcpLog.info(`Idle check: project '${this.config.projectPath}' already known, triggering init (${trigger})`);
      return {
        content: [{ type: 'text', text: msg }],
        isError: true
      };
    }
    if (this.workspaceRoot || this.originalProjectPath) {
      mcpLog.info(`Idle check: no project path yet, will try from '${this.workspaceRoot}' or '${this.originalProjectPath}'`);
      return {
        content: [{ type: 'text', text: 'Initializing, please retry in 10 seconds' }],
        isError: true
      };
    }
    mcpLog.warn(`Idle check: no search candidates available`);
    return {
      content: [{ type: 'text', text: 'No HarmonyOS project detected. Please verify the project directory or create a project first.' }],
      isError: true
    };
  }

  /** ERROR 状态下检查：自动重试（含冷却机制防止无限循环）。
   *  项目搜索由 ensureProjectReady Phase 1 统一处理，此处仅判断重试次数。
   */
  private async handleErrorCheck(): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    if (this.initRetryCount >= MAX_INIT_RETRY) {
      mcpLog.error(`Init retry limit reached (${this.initRetryCount}/${MAX_INIT_RETRY}), will not auto-retry`);
      return {
        content: [{ type: 'text', text: 'Project initialization failed multiple times. Please check project configuration and restart the MCP Server.' }],
        isError: true
      };
    }
    mcpLog.info(`Error check: auto-retrying (${this.initRetryCount}/${MAX_INIT_RETRY})`);
    this.ensureProjectReady();
    return {
      content: [{ type: 'text', text: 'Project initialization failed, auto-retrying, please retry in 10 seconds' }],
      isError: true
    };
  }

  /** 调 C/C++ 工具；未就绪时返回统一错误。 */
  private async callCppCheck(files: string[]): Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }> {
    if (!this.cppCheckTool) {
      const msg = this.config.projectPath
        ? 'C++ LSP is not ready, please retry later'
        : 'Project path is not configured. Set the PROJECT_PATH parameter or open a project in DevEco Studio.';
      mcpLog.warn(`C++ check rejected: ${msg}, files: ${files.join(', ')}`);
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
   * Update project path — 路径变更时重置状态并自动重新初始化
   */
  setProjectPath(projectPath: string): void {
    this.config.projectPath = projectPath;

    // 清理旧 Tool（无论是否有初始化在运行，都需要清理）
    if (this.arktsCheckTool) {
      this.arktsCheckTool.shutdown().catch(err => {
        mcpLog.warn('Failed to shutdown ArktsCheckTool during setProjectPath:', err);
      });
      this.arktsCheckTool = null;
    }
    if (this.cppCheckTool) {
      this.cppCheckTool.shutdown().catch(err => {
        mcpLog.warn('Failed to shutdown CppCheckTool during setProjectPath:', err);
      });
      this.cppCheckTool = null;
    }

    // 关键：处理两种情况
    if (this.initPromise) {
      // 初始化正在运行中（SYNCING/INITIALIZING）：
      // 不能直接重置状态（会导致运行中的 doEnsureProjectReady() 完成后覆盖状态），
      // 也不能调 ensureProjectReady()（initPromise 互斥会直接返回）。
      // 设置 needsReinit 标记，让 ensureProjectReady() 完成后自动重新初始化。
      //
      // 时序说明：shutdown 是立即执行的，即使 doEnsureProjectReady() 正在运行中。
      // doEnsureProjectReady() Phase 3 创建的新 arktsCheckTool 也会被此处 shutdown。
      // 最终 arktsCheckTool = null，needsReinit 触发的重新初始化会从 IDLE 状态重建所有 Tool。
      this.needsReinit = true;
      mcpLog.info('Project path changed while init is running, will reinit after current init completes');
    } else {
      // 没有初始化在运行：直接重置状态并触发
      this.projectState = ProjectLifecycle.IDLE;
      this.ensureProjectReady().catch(err => {
        mcpLog.warn('Failed to re-init project after setProjectPath:', err);
      });
    }
  }

  /**
   * Start the MCP server with stdio transport.
   *
   * project_path 优先级：
   *  1. 环境变量 PROJECT_PATH（构造时已解析）
   *  2. MCP 客户端 listRoots 返回的 workspace root
   *  3. 无 project path → LSP 初始化跳过
   */
  async start(): Promise<void> {
    // Phase 1: 协议就绪（毫秒级）
    this.toolRouter.registerToServer(this.server);
    const transport = new StdioServerTransport();
    await this.server.connect(transport);          // ← 立刻完成，MCP 连接就绪

    mcpLog.info('devecocli-mcp-server started');
    // 非 debug 模式下，打印日志文件路径
    if (!this.config.debug) {
      const logPath = getMcpLogFilePath();
      if (logPath) {
        mcpLog.info(`Log file: ${logPath}`);
      }
    }

    this.setupStdinCloseHandler();

    // Phase 2: 尝试获取 workspace root（只负责发现路径，不触发初始化）
    if (!this.config.projectPath) {
      const clientRoot = await this.getProjectRootFromClient();
      if (clientRoot) {
        this.workspaceRoot = clientRoot;
        const harmonyRoot = findHarmonyProject(clientRoot);
        if (harmonyRoot) {
          mcpLog.info(`Detected project path from client root: ${harmonyRoot}`);
          this.config.projectPath = harmonyRoot;
          this.sdkPath = this.computeSdkPath();
        } else {
          mcpLog.warn(`Client root '${clientRoot}' is not a HarmonyOS project`);
        }
      } else if (this.originalProjectPath) {
        mcpLog.warn(`PROJECT_PATH '${this.originalProjectPath}' was provided but no HarmonyOS project was found in it`);
      } else {
        mcpLog.info('project path is empty (no PROJECT_PATH env and client did not provide roots)');
      }
    } else {
      this.workspaceRoot = this.config.projectPath;
    }

    // Phase 3: 后台触发项目初始化（fire-and-forget，不阻塞）
    this.ensureProjectReady().catch(err => {
      mcpLog.warn('Background project init failed:', err);
    });

    // CppCheckTool 仍为懒初始化，不受影响
    this.initializeCppCheck();
  }

  /**
   * 从 MCP 客户端获取 workspace root。
   *
   * 参考 Rust 版 lib.rs 中 `get_project_root_from_client` 的实现：
   * 调用 `listRoots()` 获取客户端提供的 workspace roots，取第一个 root 的 URI，
   * 解析为本地文件路径。
   */
  private async getProjectRootFromClient(): Promise<string | null> {
    try {
      const result = await this.server.server.listRoots();
      const firstRoot = result.roots?.[0];
      if (!firstRoot) {
        mcpLog.warn('Client did not provide any roots');
        return null;
      }

      const uri = firstRoot.uri;
      return this.resolveFileUri(uri);
    } catch (err) {
      mcpLog.warn('Failed to list roots from client:', err);
      return null;
    }
  }

  /**
   * 将 URI 解析为本地文件路径。
   *
   * 处理以下格式：
   *  - `file:///C:/Users/project` (Windows) → `C:/Users/project`
   *  - `file:///Users/project` (macOS/Linux) → `/Users/project`
   *  - 非 file:// URI → 原样返回
   */
  private resolveFileUri(uri: string): string | null {
    // 尝试使用 URL API 解析
    try {
      const url = new URL(uri);
      if (url.protocol === 'file:') {
        // URL API 的 pathname 在 Windows 上是 `/C:/Users/project`，
        // 需要去掉前导斜杠
        const pathname = url.pathname;
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname)) {
          return pathname.substring(1);
        }
        return pathname;
      }
    } catch (err) {
      mcpLog.warn('Failed to parse URI with URL API, falling back to manual parsing:', err);
      // URL 解析失败，走手动解析
    }

    // 手动解析 file:// URI
    if (uri.startsWith('file://')) {
      let filePath = uri.substring('file://'.length);

      // URL 解码（处理 %20 等编码字符）
      filePath = decodeURIComponent(filePath);

      // Windows: file:///C:/Users/project → C:/Users/project
      if (process.platform === 'win32' && filePath.startsWith('/') && /^[A-Za-z]:/.test(filePath.substring(1))) {
        filePath = filePath.substring(1);
      }

      return filePath;
    }

    // 非 file:// URI，原样返回
    return uri;
  }

  /**
   * 监听 stdin close/end 事件，当 MCP 客户端断开连接后自动触发 shutdown 并退出进程。
   */
  private setupStdinCloseHandler(): void {
    let shutdownTriggered = false;

    const triggerShutdown = (): void => {
      if (shutdownTriggered) {
        return;
      }
      shutdownTriggered = true;
      mcpLog.info('stdin closed (MCP client disconnected), shutting down...');

      this.shutdown()
        .then(() => {
          mcpLog.info('shutdown completed, exiting process');
          process.exit(0);
        })
        .catch((err) => {
          mcpLog.error('shutdown failed:', err);
          process.exit(1);
        });
    };

    process.stdin.on('end', triggerShutdown);
    process.stdin.on('close', triggerShutdown);
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
   * 统一入口：互斥 + 内部按状态分流。
   * - initPromise 为 null → 无初始化正在进行，可以进入
   * - initPromise 非 null → 已有初始化正在进行，直接返回（幂等）
   * - 内部 doEnsureProjectReady() 根据当前状态决定行为路径
   */
  private async ensureProjectReady(): Promise<void> {
    // 互斥：已有初始化正在进行，直接返回
    if (this.initPromise) {
      return;
    }

    this.initPromise = this.doEnsureProjectReady();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }

    // 完成后检查是否有路径变更待处理（setProjectPath 在初始化运行期间被调用的情况）
    if (this.needsReinit) {
      this.needsReinit = false;
      this.projectState = ProjectLifecycle.IDLE;
      this.ensureProjectReady().catch(err => {
        mcpLog.warn('Failed to re-init project after needsReinit:', err);
      });
    }
  }

  private discoverProject(): boolean {
    const needsDiscovery = (this.projectState === ProjectLifecycle.IDLE || this.projectState === ProjectLifecycle.ERROR)
      && !this.config.projectPath;
    if (!needsDiscovery) {
      return true;
    }
    this.projectState = ProjectLifecycle.DISCOVERING;
    let found = this.workspaceRoot ? findHarmonyProject(this.workspaceRoot) : null;
    if (!found && this.originalProjectPath) {
      found = findHarmonyProject(this.originalProjectPath);
      if (found) {
        mcpLog.info(`Phase 1 found HarmonyOS project from original config: ${found}`);
      }
    }
    if (!found) {
      this.projectState = ProjectLifecycle.IDLE;
      return false;
    }
    this.config.projectPath = found;
    this.sdkPath = this.computeSdkPath();
    this.initRetryCount = 0;
    return true;
  }

  private async doEnsureProjectReady(): Promise<void> {
    if (!this.discoverProject()) {
      return;
    }

    if (!this.sdkPath) {
      this.sdkPath = this.computeSdkPath();
    }

    if (!(await this.ensureProjectSynced())) {
      return;
    }

    this.projectState = ProjectLifecycle.INITIALIZING;
    this.arktsCheckTool = new ArktsCheckTool(
      this.config.projectPath!,
      this.config.devecoPath ?? null,
      this.config.nodeMaxOldSpaceSize
    );
    // 注册配置文件变化回调：ConfigFileWatcher 检测到变化时切换状态到 IDLE 并触发重新初始化
    this.arktsCheckTool.setOnConfigChanged(() => {
      mcpLog.info('Config files changed, resetting to IDLE state for reinit');
      this.configChangedTriggeredResync = true;
      this.needsReinit = true;
      this.projectState = ProjectLifecycle.IDLE;
    });
    try {
      await this.arktsCheckTool.initialize();
      this.projectState = ProjectLifecycle.READY;
      this.initRetryCount = 0;
      mcpLog.info('Project fully initialized, check tool is available');
    } catch (err) {
      mcpLog.error('LSP initialization failed:', err);
      this.arktsCheckTool = null;
      this.initRetryCount++;
      this.projectState = ProjectLifecycle.ERROR;
    }
  }

  private async ensureProjectSynced(): Promise<boolean> {
    const projectPath = this.config.projectPath!;

    const syncCheck = checkSyncRequired(projectPath, this.config.forceSync ?? false);
    if (!syncCheck.required) {
      mcpLog.info(`Sync skipped: ${syncCheck.reason}`);
      return true;
    }

    mcpLog.info(`Sync required: ${syncCheck.reason}`);
    return this.runSync(projectPath);
  }

  private async runSync(projectPath: string): Promise<boolean> {
    this.projectState = ProjectLifecycle.SYNCING;
    mcpLog.info('Starting project sync...');
    const result = await ArktsLspManager.handleSyncProject(projectPath, this.sdkPath);
    switch (result.status) {
      case 'success':
        this.syncSkippedDueToLock = false;
        this.syncSkipStartedAt = 0;
        return true;
      case 'skipped': {
        this.syncSkippedDueToLock = true;
        if (this.syncSkipStartedAt === 0) {
          this.syncSkipStartedAt = Date.now();
        }
        const elapsedMs = Date.now() - this.syncSkipStartedAt;
        const elapsedSec = Math.round(elapsedMs / 1000);
        if (elapsedMs >= SYNC_SKIP_TIMEOUT_MS) {
          mcpLog.error(`Sync skipped for ${elapsedSec}s due to lock contention, giving up`);
          this.initRetryCount++;
          this.syncSkipStartedAt = 0;
          this.projectState = ProjectLifecycle.ERROR;
          return false;
        }
        mcpLog.warn(`Sync skipped: ${result.reason}, resetting to IDLE for retry (elapsed ${elapsedSec}s / ${SYNC_SKIP_TIMEOUT_MS / 1000}s)`);
        this.projectState = ProjectLifecycle.IDLE;
        return false;
      }
      case 'failed':
        mcpLog.error(`Project sync failed: ${result.reason}`);
        this.syncSkippedDueToLock = false;
        this.syncSkipStartedAt = 0;
        this.initRetryCount++;
        this.projectState = ProjectLifecycle.ERROR;
        return false;
    }
  }

  /** 纯计算函数：从 devecoPath 计算 sdkPath，不修改 config */
  private computeSdkPath(): string {
    // smartFindToolPath 只在 devecoPath 为空时才执行搜索，
    // 已有值时直接返回，不会覆盖用户显式设置的路径
    const resolvedDevecoPath = smartFindToolPath(this.config.devecoPath ?? '');
    const contentRoot = devecoStudioContentRoot(resolvedDevecoPath);
    return path.join(contentRoot, 'sdk');
  }

  /**
   * Shutdown the server: 关闭所有 LSP 子进程、MCP Server 连接、日志。
   */
  async shutdown(): Promise<void> {
    if (this.arktsCheckTool) {
      await this.arktsCheckTool.shutdown();
    }
    if (this.cppCheckTool) {
      await this.cppCheckTool.shutdown();
    }

    try {
      await this.server.close();
    } catch (err) {
      mcpLog.warn('Failed to close MCP server connection:', err);
    }

    mcpLog.info('devecocli-mcp-server stopped');
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
export function createMcpServer(config: McpServerConfig = {}): DevecoCliMcpServer {
  return new DevecoCliMcpServer(config);
}
