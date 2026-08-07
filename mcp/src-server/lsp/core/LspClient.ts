/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import { toUnixPath } from '../utils.js';

/**
 * 客户端配置接口
 */
export interface LspClientConfig {
    serverPath: string; // LSP server (js file) path
    logPath: string; // Log directory
    indexingDataLocation: string; // Indexing data directory
    cwd?: string; // Working directory
}

/**
 * LSP 消息处理客户端
 * 负责进程管理、流解析 (Content-Length) 和消息收发
 */
export class LspClient extends EventEmitter {
    private process: ChildProcess | null = null;
    private buffer: Buffer = Buffer.alloc(0);
    private isClosing: boolean = false;

    constructor(private config: LspClientConfig) {
        super();
    }

    /** ace-server 子进程 pid；未启动时为 null。 */
    public get pid(): number | null {
        return this.process?.pid ?? null;
    }

    /** 确保 log/index 目录存在，返回 lspLog 子目录路径。 */
    private ensureDirectories(): string {
        const lspLogPath = path.join(this.config.logPath, 'lspLog');
        if (!fs.existsSync(lspLogPath)) {
            fs.mkdirSync(lspLogPath, { recursive: true });
        }
        if (!fs.existsSync(this.config.indexingDataLocation)) {
            fs.mkdirSync(this.config.indexingDataLocation, { recursive: true });
        }
        return lspLogPath;
    }

    /**
     * 启动 LSP 进程 (对应 Java StreamMessageConsumer.start)
     */
    public async start(serverMaxSize: number): Promise<void> {
        const lspLogPath = this.ensureDirectories();
        logger.info(`[LspClient] serverMaxSize=${serverMaxSize}MB`);
        const lspPathStr = toUnixPath(lspLogPath);
        const args = [
            '--expose-gc',
            `--max-old-space-size=${serverMaxSize}`,
            '--report-on-fatalerror',
            '--report-uncaught-exception',
            `--report-filename=nodejs_error_${Date.now()}.txt`,
            `--report-dir=${lspPathStr}`,
            this.config.serverPath,
            '--stdio',
            `--logger-path=${lspPathStr}`,
            '--logger-level=TRACE',
        ];

        logger.info(`[LspClient] Starting process: node ${args.join(' ')}`);
        const nodePath = process.execPath ?? 'node';
        logger.info(`[LspClient] nodePath: ${nodePath}`);
        this.process = spawn(nodePath, args, {
            cwd: this.config.cwd || process.cwd(),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.bindProcessEvents();
        await new Promise((resolve) => setTimeout(resolve, 500));
        logger.info('[LspClient] start lsp process success');
    }

    /**
     * 接管一个已 spawn 的 LSP 子进程的 stdio，复用本实例的 Content-Length 帧解析 + 事件分发。
     * 与 {@link start} 的差异：不 spawn、不调 {@link ensureDirectories}、不做 500ms warmup。
     * 用于原生二进制 LSP server（如 clangd）—— 调用方自行 spawn 后调用本方法接管。
     *
     * @param process 已 spawn 的子进程
     * @param options.stderrAsError 是否把 stderr 输出当作致命错误（emit 'error' 事件）。
     *   - true（默认，ace-server 适用）：stderr 只应有真正的错误，触发 error 事件
     *   - false（clangd 适用）：stderr 是常规日志通道（--log=info），仅记录不触发 error
     */
    public attachProcess(process: ChildProcess, options?: { stderrAsError?: boolean }): void {
        if (this.process) {
            throw new Error('[LspClient] process already attached');
        }
        this.process = process;
        this.bindProcessEvents(options?.stderrAsError ?? true);
        logger.info('[LspClient] attached to external process');
    }

    /**
     * 绑定 stdout/stderr/exit 事件到本实例的 handleData / error 通路。
     * 由 {@link start}（ace-server spawn）与 {@link attachProcess}（外部 spawn）共用。
     *
     * @param stderrAsError 是否把 stderr 输出当作致命错误。默认 true（ace-server 适用）。
     *   clangd 等使用 stderr 作为常规日志通道的 LSP server 应传 false。
     */
    private bindProcessEvents(stderrAsError: boolean = true): void {
        if (!this.process) {
            return;
        }
        this.process.stdout?.on('data', (chunk: Buffer) => {
            this.handleData(chunk);
        });
        this.process.stderr?.on('data', (chunk: Buffer) => {
            const errorMessage = chunk.toString('utf8').trim();
            logger.error(`[LspClient] stderr: ${errorMessage}`);
            if (!this.isClosing && stderrAsError) {
                this.emit('error', new Error(`[LspClient] stderr: ${errorMessage}`));
            }
        });
        this.process.on('exit', (code) => {
            logger.info(`[LSP EXIT] code=${code}`);
            if (!this.isClosing) {
                this.emit('error', new Error(`LSP process exited with code ${code}`));
            }
        });
    }

    public sendRaw(jsonBody: string, name: string): void {
        if (!this.process?.stdin?.writable) {
            logger.warn('[LspClient] Cannot send message, stdin not writable');
            return;
        }
        logger.info(`[LspClient] send message: ${name}`);
        const message = this.buildLspMessage(jsonBody);
        this.process.stdin.write(message, 'utf8');
    }

    public send(method: string, params: unknown, id?: number | string): void {
        const message: Record<string, unknown> = {
            jsonrpc: '2.0',
            method,
            params,
        };
        if (id !== undefined) {
            message.id = id;
        }
        this.sendRaw(JSON.stringify(message), method);
    }

    /** 发送标准 LSP notification（无 id）。 */
    public sendNotification(method: string, params: unknown): void {
        this.sendRaw(
            JSON.stringify({ jsonrpc: '2.0', method, params }),
            method,
        );
    }

    /** 发送标准 LSP request（带 id，等待响应）。 */
    public sendRequest(method: string, params: unknown, id: number | string): void {
        this.sendRaw(
            JSON.stringify({ jsonrpc: '2.0', id, method, params }),
            method,
        );
    }

    private buildLspMessage(jsonBody: string): string {
        const contentBuffer = Buffer.from(jsonBody, 'utf8');
        return `Content-Length: ${contentBuffer.length}\r\n\r\n${jsonBody}`;
    }

    private handleData(data: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, data]);

        while (true) {
            const headerEndIdx = this.buffer.indexOf('\r\n\r\n');
            if (headerEndIdx === -1) {
                break;
            }

            const header = this.buffer.slice(0, headerEndIdx).toString('ascii');
            const contentLengthMatch = header.match(/Content-Length:\s*(\d+)/i);
            if (!contentLengthMatch) {
                logger.warn('[LspClient] Invalid LSP header, drop until next packet');
                this.buffer = this.buffer.slice(headerEndIdx + 4);
                continue;
            }

            const contentLength = parseInt(contentLengthMatch[1], 10);
            const bodyStartIdx = headerEndIdx + 4;
            const bodyEndIdx = bodyStartIdx + contentLength;

            if (this.buffer.length < bodyEndIdx) {
                break;
            }

            const body = this.buffer.slice(bodyStartIdx, bodyEndIdx).toString('utf8');
            const recovered = this.recoverFramedJson(body);
            if (recovered && recovered.rest.length > 0) {
                logger.warn(
                    `[LspClient] recovered mixed LSP frame, bodyLen=${body.length}, restLen=${recovered.rest.length}`,
                );
                this.emit('message', recovered.json);
                this.buffer = Buffer.concat([Buffer.from(recovered.rest, 'utf8'), this.buffer.slice(bodyEndIdx)]);
                continue;
            }
            this.emit('message', body);
            this.buffer = this.buffer.slice(bodyEndIdx);
        }
    }

    /**
     * 在已向子进程写入 exit 通知后调用：子等进程自发退出（LSP shutdown）或超时再 kill。
     */
    public waitForExitOrTimeout(timeoutMs: number): Promise<void> {
        const child = this.process;
        if (!child) {
            return Promise.resolve();
        }
        if (child.exitCode !== null || child.signalCode !== null) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            let settled = false;
            const finalize = (): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timer);
                child.off('exit', onExit);
                resolve();
            };
            const onExit = (): void => finalize();
            child.once('exit', onExit);
            const timer = setTimeout(finalize, timeoutMs);
        });
    }

    /**
     * Recover cases where one framed body contains:
     * - first complete JSON-RPC payload
     * - plus leading bytes of next `Content-Length` frame
     */
    private recoverFramedJson(body: string): { json: string; rest: string } | null {
        const start = body.search(/\S/);
        if (start < 0 || (body[start] !== '{' && body[start] !== '[')) {
            return null;
        }

        let depth = 0;
        let inString = false;
        let escapeNext = false;

        for (let i = start; i < body.length; i++) {
            const ch = body[i];

            if (inString) {
                if (escapeNext) {
                    escapeNext = false;
                    continue;
                }
                if (ch === '\\') {
                    escapeNext = true;
                    continue;
                }
                if (ch === '"') {
                    inString = false;
                }
                continue;
            }

            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{' || ch === '[') {
                depth++;
                continue;
            }
            if (ch === '}' || ch === ']') {
                depth--;
                if (depth === 0) {
                    const json = body.slice(start, i + 1);
                    const rest = body.slice(i + 1);
                    return { json, rest };
                }
            }
        }

        return null;
    }

    /**
     * 释放子进程句柄；仅当仍未退出时再 kill（常见路径是已由 LSP exit 体面退出）。
     */
    public stop(): void {
        this.isClosing = true;
        const child = this.process;
        if (!child) {
            return;
        }
        this.process = null;
        const alive = child.exitCode === null && child.signalCode === null;
        if (alive) {
            try {
                child.kill();
            } catch {
                // 进程可能已自行退出，kill 抛 ESRCH/EPERM 时忽略
            }
        }
    }
}
