/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';
import type { IncomingMessage, ServerResponse } from 'http';
import type { CallbackData } from '../types/auth';
import { NetworkConstants } from '../config/constants';

// ============ LocalAuthServer ============
export class LocalAuthServer {
  private server: http.Server | null = null;
  private port: number;
  private clientSecret: string;
  private callbackPath: string = '/callback';
  private resolveCallback: ((value: CallbackData) => void) | null = null;
  private rejectCallback: ((reason: Error) => void) | null = null;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private baseUrl: string;
  private successRedirectUrl: string;
  private failedRedirectUrl: string;

  constructor(
    port: number,
    clientSecret: string,
    baseUrl: string,
    successRedirectUrl: string,
    failedRedirectUrl: string
  ) {
    this.port = port;
    this.clientSecret = clientSecret;
    this.baseUrl = baseUrl;
    this.successRedirectUrl = successRedirectUrl;
    this.failedRedirectUrl = failedRedirectUrl;
  }

  public async start(): Promise<number> {
    const portsToTry = [this.port, ...NetworkConstants.FALLBACK_PORTS];

    for (const port of portsToTry) {
      try {
        const actualPort = await this.tryPort(port);
        this.port = actualPort;
        return actualPort;
      } catch (err) {
        if (port === portsToTry[portsToTry.length - 1]) {
          throw new Error(
            'All ports are in use. Please free up a port or close other instances.',
            { cause: err }
          );
        }
      }
    }

    throw new Error('Failed to start server');
  }

  private tryPort(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });
      // 禁用 keep-alive，避免连接保持
      server.keepAliveTimeout = 1;
      server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error('Port is already in use'));
        } else {
          reject(err);
        }
      });
      server.listen(port, '0.0.0.0', () => {
        this.server = server;
        resolve(port);
      });
    });
  }

  public async waitForCallback(timeout: number = 30000): Promise<CallbackData> {
    return new Promise((resolve, reject) => {
      this.resolveCallback = (value: CallbackData) => {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
          this.timeoutId = null;
        }
        resolve(value);
      };
      this.rejectCallback = (reason: Error) => {
        if (this.timeoutId) {
          clearTimeout(this.timeoutId);
          this.timeoutId = null;
        }
        reject(reason);
      };
      this.timeoutId = setTimeout(() => {
        this.timeoutId = null;
        this.rejectCallback?.(new Error('Callback timeout'));
      }, timeout);
    });
  }

  public async stop(): Promise<void> {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    if (!this.server) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      const server = this.server!;
      this.server = null;

      // 强制关闭所有连接（Node.js 18.2.0+）
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }

      // 设置超时保护，最多等待 100ms
      const timeout = setTimeout(() => {
        resolve();
      }, 100);

      server.close(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private handleRequest(_req: IncomingMessage, res: ServerResponse): void {
    const host = _req.headers.host || `localhost:${this.port}`;
    const url = new URL(_req.url ?? '', `http://${host}`);

    if (url.pathname !== this.callbackPath) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    try {
      const urlParams = url.searchParams;

      if (_req.method === 'POST') {
        let body = '';
        _req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        _req.on('end', () => {
          this.handleCallbackRequest(_req, res, urlParams, body);
        });
      } else {
        this.handleCallbackRequest(_req, res, urlParams, '');
      }
    } catch (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
      this.rejectCallback?.(err as Error);
    }
  }

  private handleCallbackRequest(
    _req: IncomingMessage,
    res: ServerResponse,
    urlParams: URLSearchParams,
    body: string
  ): void {
    try {
      const params = this.parseParams(urlParams, body);
      const code = params.get('code');
      const tempToken = params.get('tempToken');
      const siteId = params.get('siteId');
      const quit = params.get('quit');

      if (!this.validateCode(code)) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      if (this.isQuitRequest(quit)) {
        this.handleQuitRequest(res);
        return;
      }

      if (!tempToken || !siteId) {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }

      const callbackData: CallbackData = {
        tempToken,
        siteId,
        quit: quit ?? undefined,
      };

      this.resolveCallback?.(callbackData);
      this.sendSuccessResponse(res);
    } catch (err) {
      res.writeHead(500);
      res.end('Internal Server Error');
      this.rejectCallback?.(err as Error);
    }
  }

  private parseParams(
    urlParams: URLSearchParams,
    body: string
  ): URLSearchParams {
    if (body && body.trim()) {
      return new URLSearchParams(body);
    }
    return urlParams;
  }

  private validateCode(code: string | null): boolean {
    const codeBuffer = Buffer.from(code || '', 'utf8');
    const secretBuffer = Buffer.from(this.clientSecret, 'utf8');
    return (
      codeBuffer.length === secretBuffer.length &&
      crypto.timingSafeEqual(codeBuffer, secretBuffer)
    );
  }

  private isQuitRequest(quit: string | null): boolean {
    return quit === 'true' || quit === 'access_denied' || quit === 'quit';
  }

  private handleQuitRequest(res: ServerResponse): void {
    this.rejectCallback?.(new Error('User quit the login process'));
    res.writeHead(302, {
      Location: `${this.baseUrl}/${this.failedRedirectUrl}`,
    });
    res.end();
  }

  private sendSuccessResponse(res: ServerResponse): void {
    res.writeHead(302, {
      Location: `${this.baseUrl}/${this.successRedirectUrl}`,
    });
    res.end();
  }

  public getPort(): number {
    return this.port;
  }
}
