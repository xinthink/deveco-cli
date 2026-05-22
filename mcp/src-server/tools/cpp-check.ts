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
  COMPILE_COMMANDS_RELATIVE_SEGMENTS,
} from '../utils/common.js';
import { mcpLog } from '../utils/mcp-logger.js';
import { ModuleInfoParse } from '../lsp/parse/ModuleInfoParse.js';
import { executeBuildCommand } from '../lsp/sync/buildProject.js';

/** initialize / 单文件诊断的超时（毫秒）。 */
const INIT_TIMEOUT_MS = 60 * 1000;
const DIAGNOSTIC_TIMEOUT_MS = 30 * 1000;

/** Document sync methods that should be queued in wrapper mode. */
const DOCUMENT_SYNC_METHODS = new Set([
  'textDocument/didOpen',
  'textDocument/didChange',
  'textDocument/didClose',
  'textDocument/didSave',
]);

/** Poll interval for checking compile_commands.json availability. */
const POLL_INTERVAL_MS = 1_000;

/** Wrapper state machine states. */
type WrapperState =
  | 'preInitialize'
  | 'waitingForDatabase'
  | 'startingBackend'
  | 'proxying'
  | 'shuttingDown';

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

/** build-profile.json5 中的模块信息 */
interface ModuleInfo {
  name: string;
  srcPath: string;
  type?: string;
}

/** compile_commands.json 中的单条编译命令 */
interface CompileCommand {
  directory: string;
  command?: string;
  file?: string;
  output?: string;
}

/**
 * 内联 wrapper 模式的 clangd LSP 客户端：
 *
 * 不需要单独的 wrapper 进程/文件：
 *
 * - **Wrapper 模式**（`waitingForDatabase`）：客户端先完成假握手（`initialize` 立即返回），
 *   缓存 document sync 通知，等 compile_commands.json 出现后再连接真正的 clangd。
 * - **Proxying 模式**（`proxying`）：clangd 就绪后，所有通信直接转发，
 *   行为与原来的直连 clangd 客户端一致。
 *
 * 状态机：preInitialize → waitingForDatabase → startingBackend → proxying → shuttingDown
 */
class ClangdLspClient {
  // --- LSP protocol fields ---
  private nextRequestId: number = 1;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly diagnosticWaiters = new Map<string, DiagnosticWaiter>();
  private fileCheckLock: Promise<void> = Promise.resolve();
  private closed: boolean = false;

  // --- Wrapper state management ---
  private wrapperState: WrapperState = 'preInitialize';
  private queuedDocumentNotifications: LspMessage[] = [];
  private backendReady: boolean = false;
  private projectPath: string | null = null;

  // --- Clangd process streams (added via connectClangdProcess) ---
  private clangdStdin: NodeJS.WritableStream | null = null;
  private clangdStdout: NodeJS.ReadableStream | null = null;
  private clangdBuffer: Buffer = Buffer.alloc(0);

  constructor() {
    // Wrapper mode: no clangd streams initially.
    // The clangd process is connected later via connectClangdProcess().
  }

  /** Whether the client has been closed (for CppCheckTool polling to check). */
  isClosed(): boolean {
    return this.closed;
  }

  /**
   * 假握手：立即返回，不发送任何消息到 clangd。
   * 客户端可以先完成 LSP 握手，不必等 clangd 真正启动。
   */
  async initialize(projectPath: string): Promise<void> {
    this.projectPath = projectPath;
    this.wrapperState = 'waitingForDatabase';
  }

  /**
   * 连接到真正的 clangd 进程。发送真实的 `initialize` 请求，
   * 等待响应后转发缓存的通知，切换到 proxying 模式。
   */
  async connectClangdProcess(
    stdin: NodeJS.WritableStream,
    stdout: NodeJS.ReadableStream
  ): Promise<void> {
    if (this.closed) {
      throw new Error('Client is already closed');
    }

    this.clangdStdin = stdin;
    this.clangdStdout = stdout;
    this.wrapperState = 'startingBackend';

    // Set up clangd stdout listener
    this.clangdStdout.on('data', (chunk: Buffer) => this.handleClangdData(chunk));
    this.clangdStdout.on('error', (err) => {
      mcpLog.warn(`[CppCheck] clangd stdout error: ${err}`);
      this.failAll(new Error(`clangd stdout error: ${err}`));
    });
    this.clangdStdout.on('end', () => {
      this.failAll(new Error('C++ language server connection closed'));
    });

    // Send real initialize to clangd
    const normalizedRoot = normalizePath(this.projectPath!);
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

    await this.sendRequestToClangd('initialize', params, INIT_TIMEOUT_MS);
    await this.sendNotificationToClangd('initialized', {});

    // Mark backend as ready
    this.backendReady = true;
    this.wrapperState = 'proxying';

    // Forward queued document notifications
    for (const notification of this.queuedDocumentNotifications) {
      await this.writeToClangd(notification);
    }
    this.queuedDocumentNotifications.length = 0;

    mcpLog.info('[CppCheck] clangd backend ready, switched to proxying mode');
  }

  /**
   * 等待 clangd 后端就绪（带超时）。
   * 在 wrapper 模式下阻塞直到 connectClangdProcess() 完成；
   * 在 proxying 模式下立即返回。
   */
  private async waitForBackendReady(): Promise<void> {
    if (this.backendReady) {
      return;
    }

    const maxWait = INIT_TIMEOUT_MS;
    const start = Date.now();
    while (!this.backendReady && !this.closed && Date.now() - start < maxWait) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }

    if (!this.backendReady) {
      throw new Error('Timed out waiting for clangd backend to be ready');
    }
  }

  /**
   * 对单个文件触发诊断：didOpen → 等 publishDiagnostics → didClose。
   * 同一时刻只允许一个文件被检查（避免多文件 publishDiagnostics 混在一起）。
   * 在 wrapper 模式下会先等待 clangd 后端就绪。
   */
  async checkFile(filePath: string): Promise<JsonValue[]> {
    await this.waitForBackendReady();

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
   * 同时处理 wrapper 模式（无 clangd 进程）和 proxying 模式（有真实 clangd）。
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.wrapperState = 'shuttingDown';

    if (this.backendReady && this.clangdStdin) {
      try {
        await this.sendRequestToClangd('shutdown', null, 3000);
      } catch (err) {
        mcpLog.warn(`[CppCheck] shutdown request failed: ${err}`);
      }
      try {
        await this.sendNotificationToClangd('exit', null);
      } catch (err) {
        mcpLog.warn(`[CppCheck] exit notification failed: ${err}`);
      }
      try {
        this.clangdStdin.end();
      } catch (err) {
        mcpLog.warn(`[CppCheck] stdin.end() failed: ${err}`);
      }
    }
  }

  // ---------- internal: LSP protocol (wrapper-aware) ----------

  /**
   * 发送通知。在 wrapper 模式下缓存 document sync 通知；
   * 在 proxying 模式下直接发送到 clangd。
   */
  private async sendNotification(method: string, params: JsonValue | null): Promise<void> {
    const msg: LspMessage = {
      jsonrpc: '2.0',
      method,
      params: params ?? undefined,
    };

    if (this.backendReady && this.clangdStdin) {
      await this.writeToClangd(msg);
      return;
    }

    // Wrapper mode: cache document sync notifications
    if (DOCUMENT_SYNC_METHODS.has(method)) {
      this.queuedDocumentNotifications.push(msg);
    }
    // Other notifications in wrapper mode: silently drop
  }

  private async closeFile(fileUri: string): Promise<void> {
    await this.sendNotification('textDocument/didClose', {
      textDocument: { uri: fileUri },
    });
  }

  // ---------- internal: direct clangd communication ----------

  private async sendRequestToClangd(
    method: string,
    params: JsonValue | null,
    timeoutMs: number
  ): Promise<JsonValue> {
    const id = this.nextRequestId++;
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(id)) {
          reject(new Error(`Timed out waiting for ${method} response`));
        }
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timer });

      this.writeToClangd({
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

  private async sendNotificationToClangd(method: string, params: JsonValue | null): Promise<void> {
    await this.writeToClangd({
      jsonrpc: '2.0',
      method,
      params: params ?? undefined,
    });
  }

  private async writeToClangd(msg: LspMessage): Promise<void> {
    if (!this.clangdStdin) {
      throw new Error('clangd stdin not available');
    }

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

      const flushed = this.clangdStdin!.write(Buffer.concat([header, content]), (err) => {
        if (err) {
          settle(err);
        } else if (!settled) {
          settle();
        }
      });
      if (flushed) {
        settle();
      } else {
        const onDrain = (): void => settle();
        this.clangdStdin!.once('drain', onDrain);
      }
    });
  }

  private handleClangdData(chunk: Buffer): void {
    this.clangdBuffer = this.clangdBuffer.length === 0 ? chunk : Buffer.concat([this.clangdBuffer, chunk]);

    while (true) {
      const headerEnd = this.clangdBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        return;
      }
      const headerText = this.clangdBuffer.slice(0, headerEnd).toString('ascii');
      const lengthMatch = /content-length:\s*(\d+)/i.exec(headerText);
      if (!lengthMatch) {
        this.clangdBuffer = this.clangdBuffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = parseInt(lengthMatch[1], 10);
      const totalLength = headerEnd + 4 + contentLength;
      if (this.clangdBuffer.length < totalLength) {
        return;
      }
      const body = this.clangdBuffer.slice(headerEnd + 4, totalLength).toString('utf8');
      this.clangdBuffer = this.clangdBuffer.slice(totalLength);
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
   * 简易"互斥锁"：保证 `checkFile` 之间串行执行。
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

// ---------- C/C++ file detection helpers ----------

/** 判断给定文件路径是否是 C/C++ 源/头文件（不含 .ipp/.ixx/.inl/.inc/.tpp 等辅助扩展名）。 */
function isCppFile(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  return [
    'c', 'cpp', 'cxx', 'cc', 'h', 'hpp', 'hxx', 'hh', 'c++', 'h++',
  ].includes(ext);
}

/** 判断单个目录条目是否包含 C++ 信号（.cxx 子目录、递归子目录含 C++、或自身是 C++ 文件）。 */
function entryHasCppSignal(modulePath: string, entry: fs.Dirent): boolean {
  const fullPath = path.join(modulePath, entry.name);
  if (entry.isDirectory()) {
    return entry.name === '.cxx' || hasCppFiles(fullPath);
  }
  return isCppFile(fullPath);
}

/** 递归检查目录是否包含 C++ 文件或 .cxx 子目录。 */
function hasCppFiles(modulePath: string): boolean {
  if (!fs.existsSync(modulePath)) {
    return false;
  }
  try {
    const entries = fs.readdirSync(modulePath, { withFileTypes: true });
    return entries.some((entry) => entryHasCppSignal(modulePath, entry));
  } catch {
    // ignore permission errors
  }
  return false;
}

/** 查找项目中含有 C++ 文件的模块。 */
function findCppModules(projectPath: string): ModuleInfo[] {
  const parser = new ModuleInfoParse(projectPath);
  const allModules = parser.getAllModuleInfo();
  const cppModules: ModuleInfo[] = [];
  for (const module of allModules) {
    const normalizedSrcPath = module.srcPath.replace(/^\.\//, '');
    const modulePath = path.join(projectPath, normalizedSrcPath);
    if (hasCppFiles(modulePath)) {
      cppModules.push(module);
    }
  }
  return cppModules;
}

// ---------- compile_commands.json helpers ----------

/** 查找所有模块下的 compile_commands.json 文件。 */
function findCompileCommandsFiles(projectPath: string): string[] {
  const results: string[] = [];
  const parser = new ModuleInfoParse(projectPath);
  const modules = parser.getAllModuleInfo();

  for (const module of modules) {
    const normalizedSrcPath = module.srcPath.replace(/^\.\//, '');
    const cxxPath = path.join(projectPath, normalizedSrcPath, '.cxx');

    if (!fs.existsSync(cxxPath)) {
      continue;
    }

    findCompileCommandsRecursive(cxxPath, results);
  }

  return results;
}

/** 递归查找目录下的 compile_commands.json 文件。 */
function findCompileCommandsRecursive(dir: string, results: string[]): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findCompileCommandsRecursive(fullPath, results);
      } else if (entry.name === 'compile_commands.json') {
        results.push(fullPath);
      }
    }
  } catch {
    // ignore permission errors
  }
}

/** 合并多个 compile_commands.json 文件的内容。 */
function mergeCompileCommands(files: string[]): CompileCommand[] {
  const merged: CompileCommand[] = [];
  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(content) as CompileCommand[];
      merged.push(...parsed);
    } catch {
      // skip invalid files
    }
  }
  return merged;
}

/** 将合并后的 compile_commands 写入标准位置。 */
function writeCompileCommands(projectPath: string, commands: CompileCommand[]): void {
  const targetDir = path.join(projectPath, ...COMPILE_COMMANDS_RELATIVE_SEGMENTS.slice(0, -1));
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, 'compile_commands.json');
  fs.writeFileSync(targetPath, JSON.stringify(commands, null, 2), 'utf8');
}

/** 查找所有模块下的 compile_commands.json 并合并写入。 */
function findAndMergeCompileCommands(projectPath: string): void {
  const compileCommandsFiles = findCompileCommandsFiles(projectPath);

  if (compileCommandsFiles.length > 0) {
    const merged = mergeCompileCommands(compileCommandsFiles);
    writeCompileCommands(projectPath, merged);
    mcpLog.info(
      `[CppCheck] compile_commands.json 已生成，共 ${merged.length} 条编译命令`
    );
  } else {
    mcpLog.warn('[CppCheck] 未找到任何 compile_commands.json 文件');
  }
}

/**
 * 检查待检查的 C++ 文件是否被 compile_commands.json 覆盖。
 * 返回 true 表示全部覆盖，false 表示有文件未被覆盖需要重新初始化。
 */
function buildCoveredFileSet(commands: CompileCommand[]): Set<string> {
  const coveredFiles = new Set<string>();
  for (const cmd of commands) {
    if (!cmd.file) {
      continue;
    }
    try {
      coveredFiles.add(fs.realpathSync(cmd.file));
    } catch {
      coveredFiles.add(cmd.file);
    }
  }
  return coveredFiles;
}

function isFileCoveredBySet(file: string, coveredFiles: Set<string>): boolean {
  try {
    const canonical = fs.realpathSync(file);
    if (!coveredFiles.has(canonical)) {
      mcpLog.info(
        `[CppCheck] File not covered by compile_commands.json: ${file}`
      );
      return false;
    }
  } catch {
    // file doesn't exist, will be caught by collectValidFiles
  }
  return true;
}

function checkFilesCoveredByCompileCommands(
  compileCommandsPath: string,
  filesToCheck: string[]
): boolean {
  if (!fs.existsSync(compileCommandsPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(compileCommandsPath, 'utf8');
    const commands = JSON.parse(content) as CompileCommand[];
    const coveredFiles = buildCoveredFileSet(commands);
    for (const file of filesToCheck) {
      if (!isFileCoveredBySet(file, coveredFiles)) {
        return false;
      }
    }
    return true;
  } catch (err) {
    mcpLog.warn(`[CppCheck] Failed to read/parse compile_commands.json: ${err}`);
    return false;
  }
}

// ---------- C++ project initialization (compileNative) ----------

/**
 * 执行 compileNative 构建以生成 compile_commands.json。
 */
function runCompileNative(
  projectPath: string,
  devecoPath: string,
  cppModules: ModuleInfo[]
): void {
  const sdkPath = path.join(devecoPath, 'sdk');
  const osType = process.platform === 'win32' ? 'Windows'
    : process.platform === 'darwin' ? 'Mac'
    : 'Linux';

  // 推导 node 和 hvigor 路径
  const nodePath = process.execPath || 'node';
  const toolsDir = path.join(devecoPath, process.platform === 'darwin' ? 'Contents' : '', 'tools');
  const hvigorPath = process.platform === 'win32'
    ? path.join(toolsDir, 'hvigor', 'bin', 'hvigorw.bat')
    : path.join(toolsDir, 'hvigor', 'bin', 'hvigorw.js');

  for (const module of cppModules) {
    const hvigorArgs = [
      '--mode', 'module',
      '-p', `module=${module.name}`,
      '-p', 'product=default',
      'compileNative',
      '--analyze=normal',
      '--parallel',
      '--incremental',
      '--no-daemon',
    ].join(' ');

    mcpLog.info(`[CppCheck] Running compileNative for module: ${module.name}`);

    const result = executeBuildCommand(
      projectPath,
      nodePath,
      hvigorPath,
      sdkPath,
      hvigorArgs,
      osType
    );

    if (result.success) {
      mcpLog.info(`[CppCheck] compileNative ${module.name} 成功`);
    } else {
      mcpLog.warn(`[CppCheck] compileNative ${module.name} 失败: ${result.output}`);
    }
  }
}

/**
 * 完整的 C++ 工程初始化流程：
 * 1. 查找含 C++ 的模块
 * 2. 对每个模块执行 compileNative
 * 3. 合并 compile_commands.json
 */
function initializeCppProject(projectPath: string, devecoPath: string): void {
  const cppModules = findCppModules(projectPath);

  if (cppModules.length === 0) {
    mcpLog.info('[CppCheck] 未发现含C++的模块，跳过初始化');
    return;
  }

  mcpLog.info(
    `[CppCheck] 发现 ${cppModules.length} 个含C++的模块: ${cppModules.map((m) => m.name).join(', ')}`
  );

  runCompileNative(projectPath, devecoPath, cppModules);
  findAndMergeCompileCommands(projectPath);
}

export class CppCheckTool {
  private projectPath: string;
  /** DevEco Studio 安装路径；构造时可选，initialize 时若为空将自动查找。 */
  private devecoPath: string | null;

  private clangdProcess: ChildProcessWithoutNullStreams | null = null;
  private client: ClangdLspClient | null = null;
  private initializedProjectPath: string | null = null;
  private initializing: boolean = false;
  private initPromise: Promise<void> | null = null;

  /** Poll handle for checking compile_commands.json availability (matching Rust's poll mechanism). */
  private pollHandle: NodeJS.Timeout | null = null;
  /** Whether the clangd backend is connected and ready (matching Rust's backendReady). */
  private backendReady: boolean = false;

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
      client = await this.ensureInitializedWithFiles(cppFiles);
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
   * 带文件覆盖检查的初始化：
   * 如果待检查的文件未被 compile_commands.json 覆盖，则重新执行 compileNative。
   * 与 Rust 版 `ensure_initialized_with_files` 保持一致。
   */
  private async ensureInitializedWithFiles(filesToCheck: string[]): Promise<ClangdLspClient> {
    const normalizedProjectPath = normalizePath(this.projectPath);
    const needsInit = this.prepareCppCheck(normalizedProjectPath, filesToCheck);

    if (needsInit) {
      // 需要重新初始化：先关闭现有客户端
      if (this.client && this.initializedProjectPath) {
        mcpLog.info('[CppCheck] Re-initializing C++ project due to file changes');
        await this.shutdown();
      }

      // 执行 C++ 工程初始化（compileNative + 合并 compile_commands）
      const devecoPath = this.devecoPath ?? findDevEcoPath();
      if (!devecoPath) {
        throw new Error('DevEco Studio installation path not found');
      }
      this.devecoPath = devecoPath;
      initializeCppProject(normalizedProjectPath, devecoPath);
    } else {
      // 不需要重新初始化：检查是否已有可复用的客户端
      if (this.client && this.initializedProjectPath) {
        const normalized = normalizePath(this.projectPath);
        if (this.initializedProjectPath === normalized) {
          // 客户端存在且项目路径匹配——返回它，即使 clangd 还没连上
          // checkFile() 内部有 waitForBackendReady() 会等 clangd 就绪
          return this.client;
        }
        // 项目路径变了——关闭并重新初始化
        await this.shutdown();
      }
    }

    return this.doEnsureInitialized();
  }

  /**
   * 检查是否需要进行 C++ 初始化。
   * 返回 true 表示需要初始化，false 表示可以直接检查。
   * 与 Rust 版 `prepare_cpp_check` 保持一致。
   */
  private prepareCppCheck(projectPath: string, filesToCheck: string[]): boolean {
    const ccPath = compileCommandsPath(projectPath);

    // 1. compile_commands.json 不存在 → 需要初始化
    if (!fs.existsSync(ccPath)) {
      mcpLog.info('[CppCheck] compile_commands.json not found, needs initialization');
      return true;
    }

    // 2. 检查是否存在 cpp_modules
    const cppModules = findCppModules(projectPath);
    if (cppModules.length === 0) {
      mcpLog.info('[CppCheck] No cpp modules found, no initialization needed');
      return false;
    }

    // 3. 检查传入文件是否被 compile_commands.json 覆盖
    const covered = checkFilesCoveredByCompileCommands(ccPath, filesToCheck);
    if (!covered) {
      mcpLog.info('[CppCheck] Files not fully covered by compile_commands.json, needs initialization');
      return true;
    }

    mcpLog.info('[CppCheck] All files covered, no initialization needed');
    return false;
  }

  /**
   * 执行 LSP 客户端初始化（内部方法，不含文件覆盖检查）。
   */
  private async doEnsureInitialized(): Promise<ClangdLspClient> {
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

  /**
   * 两阶段初始化（与 Rust 版 `do_initialize` + wrapper 的 `startBackend` 一致）：
   *
   * Phase 1: 创建 ClangdLspClient（wrapper 模式），假握手立即完成。
   * Phase 2: 轮询 compile_commands.json，出现后 spawn clangd 并连接。
   */
  private async doInitialize(): Promise<void> {
    const normalizedRoot = this.resolveProjectRoot();

    // Phase 1: Create client in wrapper mode (fake initialize)
    this.client = new ClangdLspClient();
    await this.client.initialize(normalizedRoot);
    this.initializedProjectPath = normalizedRoot;

    mcpLog.info(
      `[CppCheck] Client initialized in wrapper mode for workspace: ${normalizedRoot}`
    );

    // Phase 2: Start polling for compile_commands.json
    // When it appears, spawn clangd and connect
    this.startPollingForClangd(normalizedRoot);
  }

  /**
   * 校验并解析 Harmony 工程根路径。
   * 与 Rust 版不同，不再在此处检查 compile_commands.json 或 clangd 路径——
   * 这些在 clangd 实际 spawn 时才需要（由 resolveClangdPaths 处理）。
   */
  private resolveProjectRoot(): string {
    const harmonyRoot = findHarmonyProject(this.projectPath);
    if (!harmonyRoot) {
      throw new Error(
        `Failed to find Harmony project from path: ${this.projectPath}`
      );
    }
    this.projectPath = harmonyRoot;
    return normalizePath(harmonyRoot);
  }

  /**
   * 轮询 compile_commands.json 是否出现，出现后 spawn clangd 并连接。
   * 与 Rust wrapper 的 `startPolling` + `startBackend` 行为一致。
   */
  private startPollingForClangd(normalizedRoot: string): void {
    const ccPath = compileCommandsPath(normalizedRoot);

    // Check immediately - if DB already exists, spawn clangd right away
    if (fs.existsSync(ccPath)) {
      mcpLog.info('[CppCheck] compile_commands.json found, spawning clangd immediately');
      this.spawnAndConnectClangd(normalizedRoot).catch((err) => {
        mcpLog.error(`[CppCheck] Immediate clangd spawn failed: ${err}`);
      });
      return;
    }

    mcpLog.info('[CppCheck] compile_commands.json not found, starting poll...');

    // Poll every POLL_INTERVAL_MS (matching Rust's POLL_INTERVAL_MS = 1000)
    this.pollHandle = setInterval(() => {
      if (!this.client || this.client.isClosed() || this.backendReady) {
        // Stop polling if client is gone/closed or backend is already ready
        this.stopPolling();
        return;
      }

      if (fs.existsSync(ccPath)) {
        this.stopPolling();
        mcpLog.info('[CppCheck] compile_commands.json found via poll, spawning clangd...');
        this.spawnAndConnectClangd(normalizedRoot).catch((err) => {
          mcpLog.error(`[CppCheck] Clangd spawn from poll failed: ${err}`);
        });
      }
    }, POLL_INTERVAL_MS);
  }

  private stopPolling(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  /**
   * Spawn clangd 进程并连接到 ClangdLspClient。
   * 与 Rust 版的 `LspProcessManager::start` + `CppLspClient::from_stdio` + `client.initialize` 一致，
   * 但这里 clangd 的 initialize 由 ClangdLspClient.connectClangdProcess() 内部发送。
   */
  private async spawnAndConnectClangd(normalizedRoot: string): Promise<void> {
    const { clangdPath, compileCommandsDir } = this.resolveClangdPaths(normalizedRoot);

    mcpLog.info(
      `[CppCheck] Starting clangd for workspace: ${normalizedRoot} (clangd=${clangdPath})`
    );

    const child = this.spawnClangd(clangdPath, normalizedRoot, compileCommandsDir);
    this.clangdProcess = child;

    try {
      await this.client!.connectClangdProcess(child.stdin, child.stdout);
      this.backendReady = true;
      mcpLog.info(`[CppCheck] clangd connected for workspace: ${normalizedRoot}`);
    } catch (err) {
      mcpLog.error(`[CppCheck] Failed to connect clangd: ${err}`);
      // Clean up the failed process
      if (this.clangdProcess && !this.clangdProcess.killed) {
        try {
          this.clangdProcess.kill();
        } catch {}
        this.clangdProcess = null;
      }
      throw err;
    }
  }

  /**
   * 解析 clangd 可执行文件路径和 compile_commands 目录。
   * 仅在 clangd 实际需要 spawn 时调用（不在初始化阶段调用）。
   */
  private resolveClangdPaths(normalizedRoot: string): { clangdPath: string; compileCommandsDir: string } {
    const devecoPath = this.devecoPath ?? findDevEcoPath();
    if (!devecoPath) {
      throw new Error('DevEco Studio installation path not found');
    }
    this.devecoPath = devecoPath;

    const clangdPath = findClangdPath(devecoPath);
    if (!clangdPath) {
      throw new Error('clangd executable not found inside DevEco Studio SDK');
    }

    const ccPath = compileCommandsPath(normalizedRoot);
    const compileCommandsDir = path.dirname(ccPath);

    return { clangdPath, compileCommandsDir };
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
        this.backendReady = false;
        // Don't null out client — it can be re-connected to a new clangd process
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
   * 同时清理轮询 handle（与 Rust 版的 `stopPolling` 一致）。
   */
  async shutdown(): Promise<void> {
    // Stop polling
    this.stopPolling();

    const client = this.client;
    const child = this.clangdProcess;
    this.client = null;
    this.clangdProcess = null;
    this.initializedProjectPath = null;
    this.backendReady = false;

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