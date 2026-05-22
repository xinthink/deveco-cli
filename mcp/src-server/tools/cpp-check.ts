/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import {
  compileCommandsPath,
  findClangdPath,
  findDevEcoPath,
  findHarmonyProject,
  inferCppLanguageId,
  isSupportedCppFile,
  normalizePath,
  smartFindToolPath,
  toFileUri,
} from '../utils/common.js';
import { mcpLog } from '../utils/mcp-logger.js';

/** initialize / 单文件诊断的超时（毫秒）。 */
const INIT_TIMEOUT_MS = 60 * 1000;
const DIAGNOSTIC_TIMEOUT_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 10 * 1000;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface LspMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: { code: number; message: string; data?: JsonValue };
}

interface PendingRequest {
  resolve: (result: JsonValue) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface DiagnosticWaiter {
  resolve: (diagnostics: JsonValue[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * 简化版 clangd LSP 客户端：
 * - 通过 stdio + Content-Length 帧与 clangd 通信；
 * - 维护 `pendingRequests`（id → resolver）与 `diagnosticWaiters`（fileUri → resolver）；
 * - `checkFile(filePath)` 发 `textDocument/didOpen`、等 `publishDiagnostics`、再发 `didClose`。
 */
class ClangdLspClient {
  private buffer: Buffer = Buffer.alloc(0);
  private nextRequestId: number = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly diagnosticWaiters = new Map<string, DiagnosticWaiter>();
  private fileCheckLock: Promise<void> = Promise.resolve();
  private closed: boolean = false;

  constructor(
    private readonly stdin: NodeJS.WritableStream,
    private readonly stdout: NodeJS.ReadableStream
  ) {
    this.stdout.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.stdout.on('error', (err) => {
      mcpLog.warn(`[CppCheck] clangd stdout error: ${err}`);
      this.failAll(new Error(`clangd stdout error: ${err}`));
    });
    this.stdout.on('end', () => {
      this.failAll(new Error('C++ language server connection closed'));
    });
  }

  /**
   * 发送 `initialize` 请求 + `initialized` 通知。
   * 与 Rust 实现保持一致：rootUri / workspaceFolders 都填工程根。
   */
  async initialize(projectPath: string): Promise<void> {
    const normalizedRoot = normalizePath(projectPath);
    const rootUri = toFileUri(normalizedRoot);
    const workspaceName = path.basename(normalizedRoot) || 'workspace';

    const params: JsonValue = {
      processId: null,
      clientInfo: {
        name: 'devecocli-mcp-server',
        version: process.env.npm_package_version ?? '0.0.1',
      },
      rootPath: normalizedRoot,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: workspaceName }],
      capabilities: {},
    };

    await this.sendRequest('initialize', params, INIT_TIMEOUT_MS);
    await this.sendNotification('initialized', {});
  }

  /**
   * 对单个文件触发诊断：didOpen → 等 publishDiagnostics → didClose。
   * 同一时刻只允许一个文件被检查（避免多文件 publishDiagnostics 混在一起）。
   */
  async checkFile(filePath: string): Promise<JsonValue[]> {
    const release = await this.acquireFileCheckLock();
    try {
      return await this.doCheckFile(filePath);
    } finally {
      release();
    }
  }

  private async doCheckFile(filePath: string): Promise<JsonValue[]> {
    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync(filePath);
    } catch {
      canonicalPath = filePath;
    }

    const fileUri = toFileUri(canonicalPath);
    const languageId = inferCppLanguageId(canonicalPath);
    const content = await fs.promises.readFile(canonicalPath, 'utf8');

    const diagnosticsPromise = new Promise<JsonValue[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.diagnosticWaiters.delete(fileUri)) {
          reject(
            new Error(`Timed out waiting for diagnostics: ${filePath}`)
          );
        }
      }, DIAGNOSTIC_TIMEOUT_MS);
      this.diagnosticWaiters.set(fileUri, { resolve, reject, timer });
    });

    try {
      await this.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri: fileUri,
          languageId,
          version: 1,
          text: content,
        },
      });
    } catch (err) {
      const waiter = this.diagnosticWaiters.get(fileUri);
      if (waiter) {
        clearTimeout(waiter.timer);
        this.diagnosticWaiters.delete(fileUri);
      }
      throw err;
    }

    try {
      return await diagnosticsPromise;
    } finally {
      await this.closeFile(fileUri).catch((err) => {
        mcpLog.warn(`[CppCheck] didClose failed for ${fileUri}: ${err}`);
      });
    }
  }

  /**
   * shutdown → exit 通知 → 关闭 stdin。优雅停止；调用方仍然需要负责终止 clangd 进程。
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    try {
      await this.sendRequest('shutdown', null, 3000);
    } catch (err) {
      mcpLog.warn(`[CppCheck] shutdown request failed: ${err}`);
    }
    try {
      await this.sendNotification('exit', null);
    } catch (err) {
      mcpLog.warn(`[CppCheck] exit notification failed: ${err}`);
    }
    try {
      this.stdin.end();
    } catch (err) {
      mcpLog.warn(`[CppCheck] stdin.end() failed: ${err}`);
    }
  }

  // ---------- internal: LSP protocol ----------

  private async sendRequest(
    method: string,
    params: JsonValue | null,
    timeoutMs: number = REQUEST_TIMEOUT_MS
  ): Promise<JsonValue> {
    const id = this.nextRequestId++;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error(`Timed out waiting for ${method} response`));
        }
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });

      this.writeMessage({
        jsonrpc: '2.0',
        id,
        method,
        params: params ?? undefined,
      }).catch((err) => {
        if (this.pendingRequests.delete(id)) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  private async sendNotification(
    method: string,
    params: JsonValue | null
  ): Promise<void> {
    await this.writeMessage({
      jsonrpc: '2.0',
      method,
      params: params ?? undefined,
    });
  }

  private async closeFile(fileUri: string): Promise<void> {
    await this.sendNotification('textDocument/didClose', {
      textDocument: { uri: fileUri },
    });
  }

  private writeMessage(msg: LspMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let body: string;
      try {
        body = JSON.stringify(msg);
      } catch (err) {
        reject(new Error(`Failed to encode LSP message: ${err}`));
        return;
      }
      const content = Buffer.from(body, 'utf8');
      const header = Buffer.from(
        `Content-Length: ${content.length}\r\n\r\n`,
        'ascii'
      );

      let settled = false;
      const settle = (err?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      };

      const flushed = this.stdin.write(Buffer.concat([header, content]), (err) => {
        if (err) {
          settle(err);
        }
      });
      if (flushed) {
        settle();
      } else {
        this.stdin.once('drain', () => settle());
      }
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const headerText = this.buffer.slice(0, headerEnd).toString('ascii');
      const lengthMatch = /content-length:\s*(\d+)/i.exec(headerText);
      if (!lengthMatch) {
        // 头部不合法 → 丢弃这部分（与 Rust 实现遇到无法解析时类似）。
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = parseInt(lengthMatch[1], 10);
      const totalLength = headerEnd + 4 + contentLength;
      if (this.buffer.length < totalLength) {
        return; // 等更多数据
      }
      const body = this.buffer.slice(headerEnd + 4, totalLength).toString('utf8');
      this.buffer = this.buffer.slice(totalLength);
      try {
        const msg = JSON.parse(body) as LspMessage;
        this.dispatchMessage(msg);
      } catch (err) {
        mcpLog.error(`[CppCheck] Failed to parse C++ LSP JSON message: ${err}`);
      }
    }
  }

  private dispatchMessage(msg: LspMessage): void {
    if (typeof msg.id === 'number') {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
        } else {
          pending.resolve((msg.result ?? null) as JsonValue);
        }
      }
      return;
    }

    if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
      const params = msg.params as { uri?: string; diagnostics?: JsonValue[] };
      const uri = params.uri;
      if (!uri) {
        return;
      }
      const normalizedUri = normalizeClangdUri(uri);
      const waiter = this.diagnosticWaiters.get(normalizedUri);
      if (waiter) {
        this.diagnosticWaiters.delete(normalizedUri);
        clearTimeout(waiter.timer);
        const diagnostics = Array.isArray(params.diagnostics)
          ? params.diagnostics
          : [];
        mcpLog.info(
          `[CppCheck] Received C++ diagnostics for ${normalizedUri} (${diagnostics.length} entries)`
        );
        waiter.resolve(diagnostics);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingRequests.clear();
    for (const [, waiter] of this.diagnosticWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.diagnosticWaiters.clear();
  }

  /**
   * 简易"互斥锁"：保证 `checkFile` 之间串行执行（与 Rust 端的 `file_check_lock` 等价）。
   */
  private async acquireFileCheckLock(): Promise<() => void> {
    const previous = this.fileCheckLock;
    let release!: () => void;
    this.fileCheckLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }
}

/**
 * clangd 上报的 publishDiagnostics URI 在不同平台 / 不同路径前缀下可能与我们计算的
 * `toFileUri` 不完全一致（例如盘符大小写、`%3A` vs `:`），此处尽量规范化。
 */
function normalizeClangdUri(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === 'file:') {
      let p = decodeURIComponent(url.pathname);
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
        p = p.slice(1);
      }
      return toFileUri(p);
    }
  } catch {
    // ignore
  }
  return uri;
}

export class CppCheckTool {
  private projectPath: string;
  /** DevEco Studio 安装路径；构造时可选，initialize 时若为空将自动查找。 */
  private devecoPath: string | null;
  private clangdPath: string | null = null;

  private clangdProcess: ChildProcessWithoutNullStreams | null = null;
  private client: ClangdLspClient | null = null;
  private initializedProjectPath: string | null = null;
  private initializing: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor(projectPath: string, devecoPath?: string | null) {
    this.projectPath = projectPath;
    this.devecoPath = smartFindToolPath(devecoPath ?? '') ?? devecoPath ?? null;
  }

  static getToolDefinition() {
    return {
      name: 'check_cpp_files',
      description:
        '对传入的 C/C++ 文件进行静态语法检查并返回 clangd 诊断信息。',
      inputSchema: z.object({
        files: z
          .array(z.string())
          .describe(
            '待检查的 C/C++ 文件路径列表，格式为 ["file1.cpp","file2.hpp",...]'
          ),
      }),
    };
  }

  isInitializing(): boolean {
    return this.initializing;
  }

  isInitialized(): boolean {
    return this.client !== null && this.initializedProjectPath !== null;
  }

  /**
   * 处理来自 MCP 的工具调用。
   *
   * 行为约定（与 Rust 实现保持一致）：
   *  - 入参文件相对路径相对 `projectPath` 解析；
   *  - 文件不存在 / 不是普通文件 / 不是 C/C++ 文件 → 收集到 `errors`；
   *  - 所有有效文件依次 didOpen 等诊断；
   *  - 任一文件诊断失败 → 整体返回 `isError=true`，并在结尾把 LSP 重启（避免后续残留状态）。
   */
  async handleCall(args: {
    files: string[];
  }): Promise<{ content: { type: string; text: string }[]; isError?: boolean }> {
    const errors: string[] = [];
    const infoMsgs: string[] = [];

    const cppFiles = this.collectValidFiles(args.files, errors);
    if (cppFiles.length === 0) {
      const text = errors.length > 0 ? errors.join('\n') : '没有有效的 C/C++ 文件';
      return { content: [{ type: 'text', text }], isError: true };
    }

    let client: ClangdLspClient;
    try {
      client = await this.ensureInitialized();
    } catch (err) {
      errors.push((err as Error).message);
      return {
        content: [{ type: 'text', text: errors.join('\n') }],
        isError: true,
      };
    }

    const shouldReset = await this.runDiagnosticsForFiles(client, cppFiles, errors, infoMsgs);

    if (shouldReset) {
      this.shutdown().catch((err) => {
        mcpLog.warn(`[CppCheck] shutdown after diagnostic failure: ${err}`);
      });
    }

    return this.formatCallResult(errors, infoMsgs);
  }

  /** 逐文件 didOpen + 等诊断；返回 `shouldReset`（任一文件失败即 true）。 */
  private async runDiagnosticsForFiles(
    client: ClangdLspClient,
    files: string[],
    errors: string[],
    infoMsgs: string[]
  ): Promise<boolean> {
    let shouldReset = false;
    for (const file of files) {
      try {
        const diagnostics = await client.checkFile(file);
        if (diagnostics.length === 0) {
          infoMsgs.push(`${file} => 无诊断`);
        } else {
          infoMsgs.push(`${file} => Diagnostic: ${JSON.stringify(diagnostics)}`);
        }
      } catch (err) {
        shouldReset = true;
        errors.push(`${file} => 获取诊断失败: ${(err as Error).message}`);
      }
    }
    return shouldReset;
  }

  /** 把 errors / infoMsgs 拼成最终 MCP 响应。 */
  private formatCallResult(
    errors: string[],
    infoMsgs: string[]
  ): { content: { type: string; text: string }[]; isError: boolean } {
    const isError = errors.length > 0;
    if (!isError && infoMsgs.length === 0) {
      infoMsgs.push('没有返回任何诊断信息');
    }
    const text = [infoMsgs.join('\n'), errors.join('\n')]
      .filter((part) => part.trim().length > 0)
      .join('\n')
      .trim();
    return {
      content: [{ type: 'text', text }],
      isError,
    };
  }

  /**
   * 检查并初始化 LSP。若已经为当前 `projectPath` 初始化好，直接复用。
   * 否则：校验 compile_commands.json 存在 → spawn clangd → initialize。
   */
  private async ensureInitialized(): Promise<ClangdLspClient> {
    if (this.client && this.initializedProjectPath) {
      const normalized = normalizePath(this.projectPath);
      if (this.initializedProjectPath === normalized && this.clangdProcess && !this.clangdProcess.killed) {
        return this.client;
      }
      await this.shutdown();
    }

    if (this.initPromise) {
      await this.initPromise;
      if (this.client) {
        return this.client;
      }
    }

    this.initializing = true;
    this.initPromise = this.doInitialize().finally(() => {
      this.initializing = false;
      this.initPromise = null;
    });
    await this.initPromise;
    if (!this.client) {
      throw new Error('C++ LSP failed to initialize');
    }
    return this.client;
  }

  private async doInitialize(): Promise<void> {
    const { normalizedRoot, compileCommandsDir, clangdPath } =
      this.resolveProjectAndTools();
    mcpLog.info(
      `[CppCheck] Starting clangd for workspace: ${normalizedRoot} (clangd=${clangdPath})`
    );

    const child = this.spawnClangd(clangdPath, normalizedRoot, compileCommandsDir);
    this.clangdProcess = child;
    this.client = new ClangdLspClient(child.stdin, child.stdout);

    try {
      await this.client.initialize(normalizedRoot);
    } catch (err) {
      await this.shutdown();
      throw err;
    }

    this.initializedProjectPath = normalizedRoot;
    mcpLog.info(`[CppCheck] clangd initialized for workspace: ${normalizedRoot}`);
  }

  /**
   * 校验并解析：Harmony 工程根、`compile_commands.json` 目录、DevEco 安装目录、clangd 可执行文件。
   * 任一环节失败抛错。成功时副作用：更新 `this.projectPath` / `this.devecoPath` / `this.clangdPath`。
   */
  private resolveProjectAndTools(): {
    normalizedRoot: string;
    compileCommandsDir: string;
    clangdPath: string;
  } {
    const harmonyRoot = findHarmonyProject(this.projectPath);
    if (!harmonyRoot) {
      throw new Error(
        `Failed to find Harmony project from path: ${this.projectPath}`
      );
    }
    this.projectPath = harmonyRoot;
    const normalizedRoot = normalizePath(harmonyRoot);

    const ccPath = compileCommandsPath(normalizedRoot);
    if (!fs.existsSync(ccPath)) {
      throw new Error(
        'C++工程未初始化，请先使用 project_sync 工具进行同步，同步完成后再次执行 cpp 文件检查'
      );
    }

    const devecoPath = this.devecoPath ?? findDevEcoPath();
    if (!devecoPath) {
      throw new Error('DevEco Studio installation path not found');
    }
    this.devecoPath = devecoPath;

    const clangdPath = findClangdPath(devecoPath);
    if (!clangdPath) {
      throw new Error('clangd executable not found inside DevEco Studio SDK');
    }
    this.clangdPath = clangdPath;

    return { normalizedRoot, compileCommandsDir: path.dirname(ccPath), clangdPath };
  }

  /**
   * Spawn clangd 子进程并接 stderr / exit / error 事件。stdio 必须全部 piped；
   * 若 stdin/stdout/stderr 缺失会抛错。
   */
  private spawnClangd(
    clangdPath: string,
    cwd: string,
    compileCommandsDir: string
  ): ChildProcessWithoutNullStreams {
    const child = spawn(clangdPath, [`--compile-commands-dir=${compileCommandsDir}`], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error('Failed to start clangd: stdio not available');
    }

    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trimEnd();
      if (text) {
        mcpLog.warn(`[CppLsp stderr] ${text}`);
      }
    });
    child.on('exit', (code, signal) => {
      mcpLog.warn(
        `[CppCheck] clangd exited code=${code} signal=${signal ?? 'null'}`
      );
      if (this.clangdProcess === child) {
        this.clangdProcess = null;
        this.client = null;
        this.initializedProjectPath = null;
      }
    });
    child.on('error', (err) => {
      mcpLog.error(`[CppCheck] clangd spawn error: ${err}`);
    });
    return child;
  }

  /**
   * 把入参里的路径解析为绝对路径，过滤出存在且后缀为 C/C++ 的文件。
   */
  private collectValidFiles(files: string[], errors: string[]): string[] {
    const workspace = this.projectPath;
    const valid: string[] = [];
    for (const fileArg of files) {
      const resolved = path.isAbsolute(fileArg)
        ? fileArg
        : path.join(workspace, fileArg);
      if (!fs.existsSync(resolved)) {
        errors.push(`文件不存在: ${fileArg}`);
        continue;
      }
      if (!fs.statSync(resolved).isFile()) {
        errors.push(`不是普通文件: ${fileArg}`);
        continue;
      }
      if (!isSupportedCppFile(resolved)) {
        errors.push(`不是受支持的 C/C++ 文件: ${fileArg}`);
        continue;
      }
      try {
        valid.push(fs.realpathSync(resolved));
      } catch {
        valid.push(resolved);
      }
    }
    return valid;
  }

  /**
   * 关闭 clangd 进程与 LSP 客户端。幂等。
   */
  async shutdown(): Promise<void> {
    const client = this.client;
    const child = this.clangdProcess;
    this.client = null;
    this.clangdProcess = null;
    this.initializedProjectPath = null;

    if (client) {
      try {
        await client.close();
      } catch (err) {
        mcpLog.warn(`[CppCheck] client.close() failed: ${err}`);
      }
    }
    if (child && !child.killed) {
      try {
        child.kill();
      } catch (err) {
        mcpLog.warn(`[CppCheck] failed to kill clangd: ${err}`);
      }
    }
  }
}
