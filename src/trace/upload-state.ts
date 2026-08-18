/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 上传间隔（毫秒）。MCP 调度器（startScheduler）与 CLI 后台触发（maybeSpawnTelemetryUpload）
 * 共用此阈值：MCP 按此间隔定时 flush；CLI 在 firstEventAt 距 now 超过此值时 spawn 后台进程。
 */
export const UPLOAD_INTERVAL_MS = 5 * 60 * 1000;

/** failed 文件重试间隔：CLI 后台 spawn 门控 + MCP startScheduler 的 retryTimer 共用。 */
export const RETRY_INTERVAL_MS = 60 * 60 * 1000;

/** failed 文件保留上限：文件名日期超过此值直接删除（不再重试）。 */
export const FAILED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** 打点总开关（env `DEVECO_CLI_DISABLE_TELEMETRY=1`）：关闭后不采集、不落盘、不上传。 */
export function isTelemetryDisabled(): boolean {
  const value = process.env.DEVECO_CLI_DISABLE_TELEMETRY;
  return value === '1' || value === 'true';
}

export interface UploadState {
  /** 自上次上传以来第一条事件的时间戳（ms）；null 表示无待上传事件 */
  firstEventAt: number | null;
  /** 上次成功上传的时间戳（ms）；null 表示从未上传过 */
  lastUploadAt: number | null;
  /** 上次 failed 重试的时间戳（ms）；null 表示从未重试过 */
  lastRetryAt: number | null;
}

const STATE_FILENAME = 'upload-state.json';

function stateFile(storageDir: string): string {
  return path.join(storageDir, STATE_FILENAME);
}

function defaultState(): UploadState {
  return { firstEventAt: null, lastUploadAt: null, lastRetryAt: null };
}

export function readUploadState(storageDir: string): UploadState {
  try {
    const raw = fs.readFileSync(stateFile(storageDir), 'utf8');
    const obj = JSON.parse(raw) as Partial<UploadState>;
    return {
      firstEventAt:
        typeof obj.firstEventAt === 'number' ? obj.firstEventAt : null,
      lastUploadAt:
        typeof obj.lastUploadAt === 'number' ? obj.lastUploadAt : null,
      lastRetryAt:
        typeof obj.lastRetryAt === 'number' ? obj.lastRetryAt : null,
    };
  } catch {
    return defaultState();
  }
}

export function writeUploadState(storageDir: string, state: UploadState): void {
  try {
    fs.writeFileSync(stateFile(storageDir), JSON.stringify(state), 'utf8');
  } catch {
    // 打点状态写盘失败不应影响主流程
  }
}

/** 记录一条事件时调用：若 firstEventAt 为空则置为当前时间，标记本轮待上传批次起点。 */
export function markFirstEventIfPending(storageDir: string): void {
  const state = readUploadState(storageDir);
  if (state.firstEventAt === null) {
    state.firstEventAt = Date.now();
    writeUploadState(storageDir, state);
  }
}

/** flush 完成后调用：更新 lastUploadAt，重置 firstEventAt（下一轮事件重新计时）。 */
export function markUploadComplete(storageDir: string): void {
  const state = readUploadState(storageDir);
  state.lastUploadAt = Date.now();
  state.firstEventAt = null;
  writeUploadState(storageDir, state);
}

/** retryFailed 完成后调用：更新 lastRetryAt（CLI 后台 spawn 据此按 1h 门控 failed 重试）。 */
export function markRetryComplete(storageDir: string): void {
  const state = readUploadState(storageDir);
  state.lastRetryAt = Date.now();
  writeUploadState(storageDir, state);
}

/** 解析 `telemetry-YYYY-MM-DD.txt` 文件名中的日期为本地 0 点 ms；无法解析返回 null。 */
export function parseFailedFileDate(fileName: string): number | null {
  const m = fileName.match(/^telemetry-(\d{4})-(\d{2})-(\d{2})\.txt$/);
  if (!m) {
    return null;
  }
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isFinite(ms) ? ms : null;
}

/** failed 目录是否存在文件名日期在 7 天内的待重试文件。 */
export function hasRetryableFailedFiles(
  storageDir: string,
  now: number = Date.now()
): boolean {
  const failedDir = path.join(storageDir, 'failed');
  let entries: string[];
  try {
    entries = fs.readdirSync(failedDir);
  } catch {
    return false;
  }
  for (const f of entries) {
    if (!f.startsWith('telemetry-') || !f.endsWith('.txt')) {
      continue;
    }
    const t = parseFailedFileDate(f);
    if (t !== null && now - t <= FAILED_MAX_AGE_MS) {
      return true;
    }
  }
  return false;
}

/**
 * 判断是否应 spawn 后台上传进程（OR 逻辑）：
 * - 有待上传事件且最早事件已等待超过 UPLOAD_INTERVAL_MS；或
 * - failed 目录有 7 天内文件且距上次重试超过 RETRY_INTERVAL_MS。
 * 任一成立即 spawn 同一进程，进程内 flush + retryFailed 一起执行。
 */
export function isUploadDue(
  storageDir: string,
  now: number = Date.now()
): boolean {
  const state = readUploadState(storageDir);
  if (state.firstEventAt !== null && now - state.firstEventAt >= UPLOAD_INTERVAL_MS) {
    return true;
  }
  if (
    hasRetryableFailedFiles(storageDir, now) &&
    (state.lastRetryAt === null || now - state.lastRetryAt >= RETRY_INTERVAL_MS)
  ) {
    return true;
  }
  return false;
}
