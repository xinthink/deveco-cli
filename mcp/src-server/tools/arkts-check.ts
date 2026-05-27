/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  cleanupOldSiblingDirs,
  diagnosticUriCandidates,
  findArktsLangServerPath,
  findDevEcoPath,
  findHarmonyProject,
  getMcpLogDirectory,
  getRequestId,
  normalizeDiagnosticUri,
  normalizePath,
  sleep,
  smartFindToolPath,
  toFileUri,
  toStandardPath,
  devecoStudioContentRoot,
} from '../utils/common.js';
import { mcpLog } from '../utils/mcp-logger.js';
import { ArktsLspManager } from '../lsp/ArktsLspManager.js';
import { initializeLogger } from '../lsp/logger.js';
import { toUnixPath } from '../lsp/utils.js';
import type { LspMessage } from '../lsp/types.js';

const DIAGNOSTIC_TIMEOUT_MS = 2 * 60 * 1000; // 诊断等待 2 分钟
const INIT_INITIAL_TIMEOUT_MS = 5 * 60 * 1000; // 初始化总等待 5 分钟
const INIT_RESET_TIMEOUT_MS = 3 * 60 * 1000; // 收到 indexingProgress 后重置为 3 分钟
const INDEX_DIR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // index 目录最大保留 7 天

type DiagnosticResolver = (value: unknown) => void;

interface DiagnosticWaiter {
  resolve: DiagnosticResolver;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class ArktsCheckTool {
  private manager: ArktsLspManager | null = null;
  private diagnosticWaiters: Map<string, DiagnosticWaiter> = new Map();

  private initialized: boolean = false;
  private initializing: boolean = false;
  private initPromise: Promise<void> | null = null;
  private initDeadlineTimer: NodeJS.Timeout | null = null;
  private initResolve: (() => void) | null = null;
  private initReject: ((err: Error) => void) | null = null;

  private projectPath: string;
  /** DevEco Studio 安装路径；构造时可选，initialize 时若为空将自动查找 */
  private devecoPath: string | null;
  /** arkts-lang-server (即 ace-server 的父目录)；在 initialize 时根据 devecoPath 计算 */
  private arktsLangServerPath: string | null;
  private nodeMaxOldSpaceSize?: string;

  constructor(
    projectPath: string,
    devecoPath?: string | null,
    nodeMaxOldSpaceSize?: string
  ) {
    this.projectPath = projectPath;
    this.devecoPath = devecoPath ?? '';
    this.arktsLangServerPath = null;
    this.nodeMaxOldSpaceSize = nodeMaxOldSpaceSize;
  }

  static getToolDefinition() {
    return {
      name: 'check_ets_files',
      description:
        '对传入的ets文件进行静态语法检查(ArkTS-Check)并实时返回诊断信息。',
      inputSchema: z.object({
        files: z
          .array(z.string())
          .describe(
            '待检查的 ETS 文件路径列表，格式为 ["file1.ets","file2.ets",...]'
          ),
      }),
    };
  }

  isInitializing(): boolean {
    return this.initializing;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    this.initializing = true;
    this.initPromise = this.doInitialize()
      .then(() => {
        this.initialized = true;
      })
      .finally(() => {
        this.initializing = false;
      });
    await this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const { harmonyRoot, devecoPath, arktsLangServerPath } =
      this.resolveProjectAndDeveco();

    const normalizedProjectRoot = normalizePath(harmonyRoot);
    const { logPath, indexPath } = this.getLogAndIndexPath(normalizedProjectRoot);

    // 异步清理过期 index 目录
    setImmediate(() =>
      cleanupOldSiblingDirs(indexPath, INDEX_DIR_MAX_AGE_MS, '[ArkTS-Check]')
    );

    // 把 logPath 注册给 lsp 内部的 logger（仅用于供 ace-server 子进程作为 --logger-path）。
    initializeLogger(logPath);

    const parsedMaxSize = this.nodeMaxOldSpaceSize
      ? parseInt(this.nodeMaxOldSpaceSize, 10)
      : NaN;
    const nodeMaxOldSpaceSize = Number.isNaN(parsedMaxSize) ? undefined : parsedMaxSize;

    const sdkPath = path.join(devecoStudioContentRoot(devecoPath), 'sdk');
    mcpLog.info(`ArktsCheck devecoPath: ${devecoPath}, contentRoot: ${devecoStudioContentRoot(devecoPath)}, sdkPath: ${sdkPath}`);
    this.manager = new ArktsLspManager({
      sdkPath,
      arktsLangServerPath,
      workspaceRoot: toUnixPath(normalizedProjectRoot),
      indexLogPath: indexPath,
      nodeMaxOldSpaceSize,
    });
    this.manager.setOnMessage((msg) => this.handleLspMessage(msg));

    await new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
      this.armInitTimer(INIT_INITIAL_TIMEOUT_MS);
      // start() 内部异步触发 arkts/initialized 或 arkts/initializationFailed
      this.manager!.start([]).catch((err: unknown) => {
        const e = err instanceof Error ? err : new Error(String(err));
        this.failInit(e);
      });
    });
  }

  /** 校验 / 规范化 projectPath、devecoPath、arktsLangServerPath。 */
  private resolveProjectAndDeveco(): {
    harmonyRoot: string;
    devecoPath: string;
    arktsLangServerPath: string;
  } {
    const harmonyRoot = findHarmonyProject(this.projectPath);
    if (!harmonyRoot) {
      throw new Error(
        `Failed to find Harmony project from path: ${this.projectPath}`
      );
    }
    this.projectPath = harmonyRoot;

    const devecoPath = this.devecoPath ?? findDevEcoPath();
    mcpLog.debug(`DevEco Studio installation path: ${devecoPath}, this.devecoPath: ${this.devecoPath}`);
    if (!devecoPath) {
      throw new Error('DevEco Studio installation path not found');
    }
    this.devecoPath = devecoPath;

    const arktsLangServerPath = findArktsLangServerPath(devecoPath);
    if (!arktsLangServerPath) {
      throw new Error('arkts-lang-server path not found');
    }
    this.arktsLangServerPath = arktsLangServerPath;

    return { harmonyRoot, devecoPath, arktsLangServerPath };
  }

  private armInitTimer(ms: number): void {
    if (this.initDeadlineTimer) {
      clearTimeout(this.initDeadlineTimer);
    }
    this.initDeadlineTimer = setTimeout(() => {
      const reject = this.initReject;
      this.clearInitHandlers();
      reject?.(new Error('LSP initialize timeout'));
    }, ms);
  }

  private clearInitHandlers(): void {
    if (this.initDeadlineTimer) {
      clearTimeout(this.initDeadlineTimer);
      this.initDeadlineTimer = null;
    }
    this.initResolve = null;
    this.initReject = null;
  }

  private failInit(err: Error): void {
    const reject = this.initReject;
    this.clearInitHandlers();
    reject?.(err);
  }

  /**
   * 对单个文件进行诊断检查。返回 LSP 原始的 diagnostics 数组，或包含
   * errorMessage 字段的对象。
   */
  async checkFile(filePath: string): Promise<unknown> {
    if (!this.initialized) {
      await this.initialize();
    }

    const key = normalizeDiagnosticUri(toFileUri(filePath));
    const sendUri = toStandardPath(filePath);

    const content = await fs.promises.readFile(filePath, 'utf8');
    const ext = path.extname(filePath).replace(/^\./, '');
    const languageId = `deveco.apptool.${ext || 'plaintext'}`;

    const diagnosticsPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.diagnosticWaiters.delete(key)) {
          reject(new Error('Wait for diagnostics timeout'));
        }
      }, DIAGNOSTIC_TIMEOUT_MS);
      this.diagnosticWaiters.set(key, { resolve, reject, timer });
    });

    const didOpenParams = {
      textDocument: {
        uri: sendUri,
        text: content,
        languageId,
        version: content.length,
      },
      editorFiles: [sendUri],
      isFromEditor: false,
    };

    mcpLog.debug(`textDocument/didOpen uri=${sendUri} content_len=${content.length}`);
    this.sendNotification('textDocument/didOpen', didOpenParams);

    try {
      return await diagnosticsPromise;
    } finally {
      this.sendNotification('textDocument/didClose', {
        textDocument: { uri: sendUri },
        isManual: false,
      });
    }
  }

  /**
   * 处理来自 MCP 的工具调用。
   */
  async handleCall(args: {
    files: string[];
  }): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    if (!this.initialized) {
      return this.buildNotReadyResponse();
    }

    const errors: string[] = [];
    const infoMsgs: string[] = [];

    const validFiles = this.collectValidFiles(args.files, errors);
    if (validFiles.length === 0) {
      const text = errors.length > 0 ? errors.join('\n') : '没有有效的 .ets 文件';
      return {
        content: [{ type: 'text', text }],
        isError: true,
      };
    }

    await this.runDiagnosticsForFiles(validFiles, errors, infoMsgs);
    return this.formatCallResult(errors, infoMsgs);
  }

  /** LSP 未就绪时构造统一的错误返回。 */
  private buildNotReadyResponse(): {
    content: { type: string; text: string }[];
    isError: boolean;
  } {
    const msg = this.initializing
      ? 'LSP 正在初始化中，请稍后再试'
      : !this.projectPath
        ? '没有配置工程路径，请配置PROJECT_PATH参数'
        : 'LSP未初始化';
    return {
      content: [{ type: 'text', text: msg }],
      isError: true,
    };
  }

  /** 把入参里的相对路径解析为绝对路径，并过滤出存在且后缀为 .ets 的文件。 */
  private collectValidFiles(files: string[], errors: string[]): string[] {
    const workspacePath = this.projectPath;
    const validFiles: string[] = [];
    for (const fileArg of files) {
      const resolved = path.isAbsolute(fileArg)
        ? fileArg
        : path.join(workspacePath, fileArg);

      if (!fs.existsSync(resolved)) {
        errors.push(`文件不存在: ${fileArg}`);
        continue;
      }
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        errors.push(`不是普通文件: ${fileArg}`);
        continue;
      }
      if (!resolved.endsWith('.ets')) {
        errors.push(`不是 .ets 文件: ${fileArg}`);
        continue;
      }
      validFiles.push(resolved);
    }
    return validFiles;
  }

  /** 逐个文件等待诊断，并把结果分流到 infoMsgs / errors。 */
  private async runDiagnosticsForFiles(
    files: string[],
    errors: string[],
    infoMsgs: string[]
  ): Promise<void> {
    for (const file of files) {
      await sleep(500);
      try {
        const result = await this.checkFile(file);
        infoMsgs.push(formatDiagnosticResult(file, result));
      } catch (err) {
        errors.push(
          `${file} => wait for diagnostics failed: ${(err as Error).message}`
        );
      }
    }
  }

  /** 把 errors / infoMsgs 拼成最终 MCP 响应。 */
  private formatCallResult(
    errors: string[],
    infoMsgs: string[]
  ): { content: { type: string; text: string }[]; isError: boolean } {
    const parts: string[] = [];
    if (errors.length > 0) {
      parts.push(errors.join('\n'));
    }
    if (infoMsgs.length > 0) {
      parts.push(infoMsgs.join('\n'));
    }
    let content = parts.join('\n').trim();
    const isError = errors.length > 0;
    if (!isError && infoMsgs.length === 0) {
      content = '未收集到诊断信息';
    }
    return {
      content: [{ type: 'text', text: content }],
      isError,
    };
  }

  async shutdown(): Promise<void> {
    this.failAllPending(new Error('LSP shutting down'));

    if (this.manager) {
      try {
        await this.manager.dispose();
      } catch (e) {
        mcpLog.warn(`Failed to dispose ArktsLspManager: ${e}`);
      }
      this.manager = null;
    }

    this.initialized = false;
    this.initializing = false;
    this.initPromise = null;
    this.clearInitHandlers();
  }

  // ---------- LSP I/O ----------

  private sendNotification(method: string, params: unknown): void {
    if (!this.manager) {
      throw new Error('ArktsLspManager not initialized');
    }
    this.manager.sendNotification({ jsonrpc: '2.0', method, params });
  }

  private handleLspMessage(msg: LspMessage): void {
    // LspMessage 已经是 JSON 对象（不再有 stdin/Content-Length 解析），按 method 分流。
    const record = msg as unknown as Record<string, unknown>;
    const method = record.method as string | undefined;
    if (!method) {
      return;
    }

    switch (method) {
      case 'textDocument/publishDiagnostics':
      case 'textDocument/didOpen':
        this.handleDiagnosticsNotification(
          record.params as Record<string, unknown> | undefined
        );
        break;

      case 'arkts/indexingProgress':
        // 重置初始化超时
        if (this.initResolve) {
          this.armInitTimer(INIT_RESET_TIMEOUT_MS);
          mcpLog.debug('Received arkts/indexingProgress, reset init timeout');
        }
        break;

      case 'arkts/initialized': {
        mcpLog.info('Received arkts/initialized');
        const resolve = this.initResolve;
        this.clearInitHandlers();
        resolve?.();
        break;
      }

      case 'arkts/initializationFailed': {
        const params = record.params as { message?: string } | undefined;
        const reason = params?.message ?? 'unknown';
        mcpLog.error(`LSP initialization failed: ${reason}`);
        const reject = this.initReject;
        this.clearInitHandlers();
        reject?.(new Error(`LSP initialize failed: ${reason}`));
        break;
      }

      default:
        break;
    }
  }

  private handleDiagnosticsNotification(
    params: Record<string, unknown> | undefined
  ): void {
    if (!params) {
      return;
    }
    const uri = params.uri as string | undefined;
    if (!uri) {
      return;
    }

    const waiter = this.resolveDiagnosticWaiter(uri);
    if (!waiter) {
      return;
    }

    if (typeof params.errorMessage === 'string') {
      mcpLog.warn(`diagnostics error uri=${uri} message=${params.errorMessage}`);
      waiter.resolve({ errorMessage: params.errorMessage });
      return;
    }
    const diagnostics = params.diagnostics;
    const count = Array.isArray(diagnostics) ? diagnostics.length : 0;
    mcpLog.debug(`diagnostics received uri=${uri} count=${count}`);
    waiter.resolve(Array.isArray(diagnostics) ? diagnostics : []);
  }

  /** Pop a waiter that matches `uri`, trying the normalized key first then any candidate URIs. */
  private resolveDiagnosticWaiter(uri: string): DiagnosticWaiter | undefined {
    const normalizedKey = normalizeDiagnosticUri(uri);
    const direct = this.popDiagnosticWaiter(normalizedKey);
    if (direct) {
      return direct;
    }
    for (const candidate of diagnosticUriCandidates(uri)) {
      const w = this.popDiagnosticWaiter(candidate);
      if (w) {
        return w;
      }
    }
    return undefined;
  }

  private popDiagnosticWaiter(key: string): DiagnosticWaiter | undefined {
    const w = this.diagnosticWaiters.get(key);
    if (!w) {
      return undefined;
    }
    this.diagnosticWaiters.delete(key);
    clearTimeout(w.timer);
    return w;
  }

  private failAllPending(err: Error): void {
    for (const [, w] of this.diagnosticWaiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this.diagnosticWaiters.clear();
    const reject = this.initReject;
    this.clearInitHandlers();
    reject?.(err);
  }

  // ---------- log / index 目录管理 ----------

  /**
   * 返回 (logPath, indexPath):
   * - logPath:   `<ArkTSCheck>/lsp-log/<request_id>/<nano_time>`
   * - indexPath: `<ArkTSCheck>/lsp-index/<request_id>`
   */
  private getLogAndIndexPath(projectRoot: string): {
    logPath: string;
    indexPath: string;
  } {
    try {
      const baseLogDir = path.join(getMcpLogDirectory(), 'ArkTSCheck');
      const mappingConfigPath = path.join(baseLogDir, 'mapping-config.properties');
      const requestId = getRequestId(projectRoot, mappingConfigPath);

      const nanoTime = `${Date.now()}${process.hrtime.bigint() % 1000000n}`;
      const logPath = path.join(
        baseLogDir,
        'lsp-log',
        String(requestId),
        nanoTime
      );
      const indexPath = path.join(baseLogDir, 'lsp-index', String(requestId));

      fs.mkdirSync(logPath, { recursive: true });
      fs.mkdirSync(indexPath, { recursive: true });

      return {
        logPath: normalizePath(logPath),
        indexPath: normalizePath(indexPath),
      };
    } catch {
      return { logPath: 'auto', indexPath: 'auto' };
    }
  }
}

/**
 * 把 `checkFile` 的返回值格式化为单行人类可读字符串。
 *  - 数组：空 => `no diagnostics`，否则序列化诊断列表
 *  - `{ errorMessage }`：诊断失败提示
 *  - 其它：兜底序列化
 */
function formatDiagnosticResult(file: string, result: unknown): string {
  if (Array.isArray(result)) {
    if (result.length === 0) {
      return `${file} => no diagnostics`;
    }
    return `${file} => Diagnostic: ${JSON.stringify(result)}`;
  }
  if (
    result &&
    typeof result === 'object' &&
    typeof (result as { errorMessage?: unknown }).errorMessage === 'string'
  ) {
    const errorMessage = (result as { errorMessage: string }).errorMessage;
    return `${file} diagnostic failed, error_message: ${errorMessage}`;
  }
  return `${file} => diagnostic failed, result: ${JSON.stringify(result)}`;
}
