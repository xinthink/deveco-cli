/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceUploader } from './trace-uploader.js';
import { eventSerializer } from './json-serializer.js';
import {
  createTraceFileKey,
  decryptTraceLine,
  encryptTraceLine,
} from './file-crypto.js';
import { mcpLog } from '../../mcp/src-server/utils/mcp-logger.js';
import type { BaseEvent, TrackMeasurement, TraceEvent } from './events.js';
import {
  UPLOAD_INTERVAL_MS,
  isTelemetryDisabled,
  markFirstEventIfPending,
  markUploadComplete,
} from './upload-state.js';
import { resolveDeviceId } from './device-id.js';

export class Telemetry {
  private static readonly MAX_BATCH = 200;
  /** 单批 payload 字节数上限(约 1.7 MiB) */
  private static readonly MAX_PAYLOAD_BYTES = Math.floor(1.7 * 1024 * 1024);
  /** 打点平台版本 */
  private static readonly TRACE_OS_VERSION = '1.0';
  private static readonly COUNTRY_CODE = 'CN';
  private static readonly EVENT_PREFIX = 'devecocli_';

  private readonly uploader = new TraceUploader();
  private storageDir = '';
  private failedDir = '';
  private deviceId = '';
  /** 打点总开关：关闭后不采集/不落盘/不上传（upload-state.ts isTelemetryDisabled） */
  private readonly disabled = isTelemetryDisabled();
  /** 落盘加密密钥，由 deviceId 派生（file-crypto.ts） */
  private traceFileKey: Buffer = Buffer.alloc(0);
  private readonly sessionId = crypto.randomUUID();
  private cliVersion = '';
  private devecoStudioVersion: string | null = null;
  private sourceType = '';
  private cltVersion: string | null = null;
  private nodeVersion = '';
  private initialTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;

  constructor() {
    mcpLog.info(`[telemetry] instance created, sessionId=${this.sessionId}`);
  }

  init(storageDir: string): void {
    this.storageDir = storageDir;
    this.failedDir = path.join(storageDir, 'failed');
    this.cliVersion = process.env.npm_package_version || '0.0.0';
    this.nodeVersion = process.version;
    this.deviceId = resolveDeviceId(storageDir).replace(/-/g, '');
    this.traceFileKey = createTraceFileKey(this.deviceId);
    fs.mkdirSync(storageDir, { recursive: true });
    fs.mkdirSync(this.failedDir, { recursive: true });
    mcpLog.info(
      `[telemetry] init: dir=${storageDir}, failedDir=${this.failedDir}, ` +
        `cliVersion=${this.cliVersion}, os=${this.resolveOsName()}, arch=${this.resolveOsArch()}, node=${this.nodeVersion}`
    );
  }

  setStudioVersion(version: string): void {
    this.devecoStudioVersion = version;
    mcpLog.info(`[telemetry] studio version set: ${version}`);
  }

  setSourceType(sourceType: string): void {
    this.sourceType = sourceType;
    mcpLog.info(`[telemetry] sourceType set: ${sourceType}`);
  }

  setCltVersion(version: string): void {
    this.cltVersion = version;
    mcpLog.info(`[telemetry] CLT version set: ${version}`);
  }

  track<T>(event: BaseEvent, fn: () => Promise<T> | T): Promise<T>;
  track(event: BaseEvent, measurement: TrackMeasurement): Promise<void>;
  track(event: BaseEvent): Promise<void>;
  async track<T>(
    event: BaseEvent,
    fnOrMeasurement?: (() => Promise<T> | T) | TrackMeasurement,
  ): Promise<T | undefined> {
    if (this.disabled) {
      // 关闭打点：不采集不记录，但 fn 照常执行并透传结果/异常
      if (typeof fnOrMeasurement === 'function') {
        return fnOrMeasurement();
      }
      return undefined;
    }
    if (!this.storageDir) {
      throw new Error('Telemetry not initialized. Call init() first.');
    }
    mcpLog.info(`[telemetry] track: ${event.event}`);
    if (!fnOrMeasurement) {
      await this.record(event, 0, true, null);
      mcpLog.info(
        `[telemetry] track recorded: ${event.event} (no measurement)`
      );
      return undefined;
    }
    if (typeof fnOrMeasurement !== 'function') {
      const m = fnOrMeasurement;
      await this.record(event, m.duration_ms, m.success, m.error_code);
      mcpLog.info(
        `[telemetry] track recorded: ${event.event} (measurement: duration=${m.duration_ms}ms, success=${m.success}, code=${m.error_code})`
      );
      return undefined;
    }
    const fn = fnOrMeasurement;
    const start = Date.now();
    try {
      const result = await fn();
      const duration = Date.now() - start;
      await this.record(event, duration, true, null);
      mcpLog.info(
        `[telemetry] track success: ${event.event}, duration=${duration}ms`
      );
      return result;
    } catch (e) {
      const duration = Date.now() - start;
      const code = this.toErrorCode(e);
      await this.record(event, duration, false, code);
      mcpLog.info(
        `[telemetry] track failed: ${event.event}, duration=${duration}ms, code=${code}`
      );
      throw e;
    }
  }

  private async record(
    event: BaseEvent,
    durationMs: number,
    success: boolean,
    errorCode: string | null
  ): Promise<void> {
    const traceEvent = this.buildTraceEvent(
      event,
      durationMs,
      success,
      errorCode
    );
    try {
      const line = encryptTraceLine(
        JSON.stringify(traceEvent),
        this.traceFileKey
      );
      await fs.promises.appendFile(this.currentFile(), line + '\n', 'utf8');
      mcpLog.info(
        `[telemetry] event persisted: ${traceEvent.properties.trace_uuid}`
      );
      markFirstEventIfPending(this.storageDir);
    } catch (e) {
      mcpLog.error('[telemetry] track write error:', e);
    }
  }

  private buildTraceEvent(
    event: BaseEvent,
    durationMs: number,
    success: boolean,
    errorCode: string | null
  ): TraceEvent {
    const wireEvent = `${Telemetry.EVENT_PREFIX}${event.event}`;
    const eventDetail = eventSerializer.toObject(event) as Record<
      string,
      unknown
    >;
    if (eventDetail && typeof eventDetail === 'object') {
      delete eventDetail.event;
    }
    return {
      countryCode: Telemetry.COUNTRY_CODE,
      event: wireEvent,
      eventtime: String(Date.now()),
      properties: {
        uid: this.deviceId,
        trace_uuid: crypto.randomUUID(),
        trace_os_version: Telemetry.TRACE_OS_VERSION,
        os_arch: this.resolveOsArch(),
        action: wireEvent,
        trace_os_name: this.resolveOsName(),
        version: `${this.cliVersion}_${this.resolveOsSuffix()}`,
        deveco_studio_version: this.formatVersion(this.devecoStudioVersion),
        command_line_version: this.formatVersion(this.cltVersion),
        source_type: this.sourceType,
        session_id: this.sessionId,
        node_version: this.nodeVersion,
        duration_ms: durationMs,
        success,
        error_code: errorCode,
        event_detail: eventDetail,
      },
    };
  }

  private toErrorCode(e: unknown): string {
    if (e instanceof Error) {
      const code = (e as NodeJS.ErrnoException).code;
      return code ?? e.name;
    }
    return 'UnknownError';
  }

  private resolveOsArch(): string {
    const arch = os.arch();
    return arch === 'x64' ? 'amd64' : arch;
  }

  private resolveOsName(): string {
    switch (process.platform) {
      case 'win32': {
        const parts = os.release().split('.');
        const build = parseInt(parts[parts.length - 1], 10) || 0;
        return build >= 22000 ? 'Windows 11' : 'Windows 10';
      }
      case 'darwin':
        return 'macOS';
      case 'linux':
        return 'Linux';
      default:
        return process.platform;
    }
  }

  private resolveOsSuffix(): string {
    switch (process.platform) {
      case 'win32':
        return 'windows';
      case 'darwin':
        return os.arch() === 'arm64' ? 'mac_arm' : 'mac';
      default:
        return 'linux';
    }
  }

  /** 版本格式化：有值则 `<version>_<os>`，无值则空字符串。 */
  private formatVersion(version: string | null): string {
    return version ? `${version}_${this.resolveOsSuffix()}` : '';
  }

  private dateString(): string {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  private currentFile(): string {
    return path.join(this.storageDir, `telemetry-${this.dateString()}.txt`);
  }

  startScheduler(): void {
    this.stopScheduler();
    if (this.disabled) {
      mcpLog.info('[telemetry] scheduler not started (telemetry disabled)');
      return;
    }
    mcpLog.info(
      `[telemetry] scheduler started (first flush in ${UPLOAD_INTERVAL_MS / 1000}s, then every ${UPLOAD_INTERVAL_MS / 1000}s)`
    );
    this.initialTimer = setTimeout(() => {
      this.flush().catch((e) => mcpLog.error('[telemetry] flush error:', e));
      this.intervalTimer = setInterval(() => {
        this.flush().catch((e) => mcpLog.error('[telemetry] flush error:', e));
      }, UPLOAD_INTERVAL_MS);
    }, UPLOAD_INTERVAL_MS);
  }

  stopScheduler(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    mcpLog.info('[telemetry] scheduler stopped');
  }

  async flush(): Promise<boolean> {
    if (this.disabled) {
      return true;
    }
    if (!this.storageDir) {
      throw new Error('Telemetry not initialized. Call init() first.');
    }
    mcpLog.info('[telemetry] flush start');
    const files = await this.listPendingFiles();
    if (files.length === 0) {
      mcpLog.info('[telemetry] flush: no event files');
      return true;
    }
    mcpLog.info(`[telemetry] flush: ${files.length} file(s) pending`);
    let allOk = true;
    for (const file of files) {
      if (!(await this.flushFile(file))) {
        allOk = false;
      }
    }
    mcpLog.info(`[telemetry] flush done, allOk=${allOk}`);
    markUploadComplete(this.storageDir);
    return allOk;
  }

  private async listPendingFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.storageDir);
    } catch {
      return [];
    }
    return entries
      .filter((f) => f.startsWith('telemetry-') && f.endsWith('.txt'))
      .map((f) => path.join(this.storageDir, f))
      .sort();
  }

  private async flushFile(file: string): Promise<boolean> {
    const pendingFile = file + '.pending';
    try {
      await fs.promises.rename(file, pendingFile);
      mcpLog.info(
        `[telemetry] flush: renamed ${path.basename(file)} → pending`
      );
    } catch {
      return false;
    }
    let content: string;
    try {
      content = await fs.promises.readFile(pendingFile, 'utf8');
    } catch {
      return false;
    }
    const rawLines = content
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const lines: string[] = [];
    let skipped = 0;
    for (const line of rawLines) {
      const plain = decryptTraceLine(line, this.traceFileKey);
      if (plain === null) {
        skipped++;
        continue;
      }
      lines.push(plain);
    }
    if (skipped > 0) {
      mcpLog.warn(
        `[telemetry] flush: skipped ${skipped} undecryptable line(s)`
      );
    }
    if (lines.length === 0) {
      try {
        await fs.promises.unlink(pendingFile);
      } catch {
        // ignore
      }
      return true;
    }
    return this.uploadInBatches(pendingFile, lines);
  }

  private async uploadInBatches(
    pendingFile: string,
    lines: string[]
  ): Promise<boolean> {
    let cursor = 0;
    while (cursor < lines.length) {
      const batchStart = cursor;
      const batch: string[] = [];
      let approxBytes = 16; // [{action,detail,timestamp}] 基础开销
      while (cursor < lines.length && batch.length < Telemetry.MAX_BATCH) {
        const line = lines[cursor];
        const inc = Buffer.byteLength(line, 'utf8') + 1; // +1 comma
        if (
          batch.length > 0 &&
          approxBytes + inc > Telemetry.MAX_PAYLOAD_BYTES
        ) {
          break;
        }
        batch.push(line);
        approxBytes += inc;
        cursor++;
      }
      const items = this.buildPayloadItems(batch);
      const payload = JSON.stringify(items);
      mcpLog.info(
        `[telemetry] flush: uploading batch (${items.length} events, ${Buffer.byteLength(payload, 'utf8')} bytes)`
      );
      let ok = false;
      try {
        ok = await this.uploader.upload(payload, this.deviceId);
      } catch (e) {
        mcpLog.error('[telemetry] build/upload error:', e);
      }
      if (!ok) {
        const remaining = lines.slice(batchStart).join('\n') + '\n';
        await this.moveToFailed(pendingFile, remaining);
        return false;
      }
    }
    try {
      await fs.promises.unlink(pendingFile);
    } catch {
      // ignore
    }
    mcpLog.info('[telemetry] flush: file done, pending removed');
    return true;
  }

  /** 原始 TraceEvent 行 → 新接口数组元素：action 取原 event 字段，detail 传 properties 层（去掉 countryCode 等外层）。 */
  private buildPayloadItems(
    lines: string[]
  ): { action: string; detail: string; timestamp: number }[] {
    const items: { action: string; detail: string; timestamp: number }[] = [];
    for (const line of lines) {
      try {
        const traceEvent = JSON.parse(line) as TraceEvent;
        items.push({
          action: traceEvent.event,
          detail: JSON.stringify(traceEvent.properties),
          timestamp: Number(traceEvent.eventtime) || Date.now(),
        });
      } catch {
        // 跳过无法解析的行
      }
    }
    return items;
  }

  private async moveToFailed(
    pendingFile: string,
    content: string
  ): Promise<void> {
    const baseName = path.basename(pendingFile, '.pending');
    const failedPath = path.join(this.failedDir, baseName);
    mcpLog.info(`[telemetry] moving to failed: ${baseName}`);
    try {
      const encrypted =
        content
          .split('\n')
          .filter(Boolean)
          .map((line) => encryptTraceLine(line, this.traceFileKey))
          .join('\n') + '\n';
      await fs.promises.appendFile(failedPath, encrypted, 'utf8');
    } catch (e) {
      mcpLog.error('[telemetry] move to failed error:', e);
      return;
    }
    try {
      await fs.promises.unlink(pendingFile);
    } catch {
      // ignore
    }
  }
}
