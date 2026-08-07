/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import https from 'node:https';
import { mcpLog } from '../../mcp/src-server/utils/mcp-logger.js';

interface HttpResponse {
  code: number;
  body: string;
}

/**
 * codeGenie trace 上传器。
 * 协议对齐 test_upload 样例（uploader.ts flush）：
 * POST <endpoint>，headers 带 sender / deviceid，body 为明文 JSON 数组
 * [{ action, detail: <事件对象 JSON 字符串>, timestamp }, ...]。
 */
export class TraceUploader {
  private static readonly DEBUG = true;

  static readonly ENDPOINT =
    'https://cn.devecostudio.huawei.com/codeGenie/cli/trace/upload';
  static readonly SENDER = 'deveco-cli';

  public async upload(payload: string, deviceId: string): Promise<boolean> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      sender: TraceUploader.SENDER,
      deviceid: deviceId.replace(/-/g, ''),
      'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
    };
    TraceUploader.log(`upload request: URL=${TraceUploader.ENDPOINT}`);

    try {
      const { code, body: respBody } = await this.httpPost(
        TraceUploader.ENDPOINT,
        headers,
        Buffer.from(payload, 'utf8'),
        60000
      );
      TraceUploader.log(`upload response: status=${code}, body=${respBody}`);
      return TraceUploader.isSuccess(respBody);
    } catch (e) {
      TraceUploader.log(
        `upload failed: ${e instanceof Error ? e.message : String(e)}`
      );
      return false;
    }
  }

  /** 服务端返回体解析：errorCode 为 200 视为成功（兼容 number / string 两种类型）。 */
  private static isSuccess(body: string): boolean {
    try {
      const parsed = JSON.parse(body) as { errorCode?: unknown };
      return String(parsed?.errorCode) === '200';
    } catch {
      return false;
    }
  }

  private async httpPost(
    url: string,
    headers: Record<string, string>,
    body: Buffer,
    timeoutMs: number
  ): Promise<HttpResponse> {
    const target = new URL(url);
    return new Promise<HttpResponse>((resolve, reject) => {
      const req = https.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: target.pathname + target.search,
          method: 'POST',
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              code: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error('request timeout'));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private static log(msg: string): void {
    if (TraceUploader.DEBUG) {
      mcpLog.info('[TRACE]' + msg);
    }
  }
}
