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
}

const STATE_FILENAME = 'upload-state.json';

function stateFile(storageDir: string): string {
  return path.join(storageDir, STATE_FILENAME);
}

function defaultState(): UploadState {
  return { firstEventAt: null, lastUploadAt: null };
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

/** 判断是否应触发后台上传：有待上传事件且最早事件已等待超过 UPLOAD_INTERVAL_MS。 */
export function isUploadDue(
  storageDir: string,
  now: number = Date.now()
): boolean {
  const state = readUploadState(storageDir);
  if (state.firstEventAt === null) {
    return false;
  }
  return now - state.firstEventAt >= UPLOAD_INTERVAL_MS;
}
