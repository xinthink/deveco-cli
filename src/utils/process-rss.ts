/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { debugLog } from './logger.js';

const POWERSHELL_PATH = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
let cachedPsAvailable: boolean | undefined;

function isPowerShellAvailable(): boolean {
  if (cachedPsAvailable === undefined) {
    cachedPsAvailable = existsSync(POWERSHELL_PATH);
  }
  return cachedPsAvailable;
}

/**
 * 按 pid 读子进程 RSS（KB 数字字符串）。macOS/Linux 用 `ps -o rss=`，Windows 用
 * `tasklist /fo csv`；失败/超时返回 null，不抛错。每次调用 spawn 一个短命令，
 * 故仅用于低频采样（如打点），勿用于热路径。
 */
export function readProcessRss(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const file = isWin ? 'tasklist' : 'ps';
    const args = isWin
      ? ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh']
      : ['-o', 'rss=', '-p', String(pid)];
    debugLog(`Executing: ${file} ${args.join(' ')}`);
    execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(isWin ? parseWindowsRss(stdout) : parsePsRss(stdout));
    });
  });
}

/**
 * 获取指定 PID 的所有直接子进程 PID 列表。
 */
async function getChildPids(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let file: string;
    let args: string[];

    if (isWin) {
      if (!isPowerShellAvailable()) {
        resolve([]);
        return;
      }
      file = POWERSHELL_PATH;
      args = [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | Select-Object -ExpandProperty ProcessId`
      ];
    } else {
      file = 'ps';
      args = ['-o', 'pid=', '--ppid', String(pid)];
    }

    execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      const pids: number[] = [];
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && /^\d+$/.test(trimmed)) {
          pids.push(Number(trimmed));
        }
      }
      resolve(pids);
    });
  });
}

/**
 * 递归计算进程树的总 RSS（字节）。
 * 包含根进程及其所有子孙进程。
 */
export async function sumProcessTreeRss(rootPid: number): Promise<number> {
  let totalBytes = 0;

  const rootRssKb = await readProcessRss(rootPid);
  if (rootRssKb) {
    totalBytes += Number(rootRssKb) * 1024;
  }

  const children = await getChildPids(rootPid);
  for (const childPid of children) {
    totalBytes += await sumProcessTreeRss(childPid);
  }

  return totalBytes;
}

/** 字节数格式化为 MB 字符串（保留两位），如 `123.45MB`。 */
export function formatBytesMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

/**
 * 采样一次 RSS(字节):有 pid 时读目标进程(可选进程树),否则读当前 Node 进程。
 */
async function sampleProcessRss(
  pid: number | undefined,
  trackTree: boolean
): Promise<number> {
  if (!pid) {
    return process.memoryUsage().rss;
  }
  if (trackTree) {
    return sumProcessTreeRss(pid);
  }
  const rssKb = await readProcessRss(pid);
  return rssKb ? Number(rssKb) * 1024 : 0;
}

/**
 * 启动内存采样器，按固定间隔轮询指定进程（或当前进程）的 RSS 峰值。
 * @param pid 目标进程 PID；省略则采样当前 Node.js 进程
 * @param intervalMs 采样间隔，默认 500ms
 * @param trackTree 如果为 true，则采样进程树（根进程 + 所有子孙进程）的总 RSS
 * @returns 包含 `stop()` 方法，调用后返回最终峰值字节数
 */
export function startMemoryTracker(
  pid?: number,
  intervalMs = 500,
  trackTree = false
): { stop: () => Promise<number> } {
  let peakBytes = 0;
  let isStopping = false;

  const interval = setInterval(async () => {
    if (isStopping) {
      return;
    }
    const currentBytes = await sampleProcessRss(pid, trackTree);
    if (currentBytes > peakBytes) {
      peakBytes = currentBytes;
    }
  }, intervalMs);

  return {
    stop: async () => {
      isStopping = true;
      clearInterval(interval);
      const finalBytes = await sampleProcessRss(pid, trackTree);
      return Math.max(peakBytes, finalBytes);
    },
  };
}

function parsePsRss(stdout: string): string | null {
  const m = stdout.trim().match(/^(\d+)$/);
  return m ? m[1] : null;
}

function parseWindowsRss(stdout: string): string | null {
  // tasklist /fo csv /nh: "name","pid","session","session#","N,NNN K"
  const m = stdout.match(/"([^"]+?)\s*K"/i);
  if (!m) {
    return null;
  }
  const digits = m[1].replace(/\D/g, '');
  return digits || null;
}
