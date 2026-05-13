/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return '';
}

function isDownloadedTrue(obj: Record<string, unknown>): boolean {
  const d = obj.downloaded ?? obj.Downloaded;
  return d === true || String(d).toLowerCase() === 'true';
}

export function parseDownloadedOsVersionsFromImageList(
  stdout: string
): string[] {
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  try {
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data)) {
      return [];
    }
    const out: string[] = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const row = item as Record<string, unknown>;
      if (!isDownloadedTrue(row)) {
        continue;
      }
      const ver = pickString(row, [
        'osVersion',
        'OsVersion',
        'OSVersion',
        'os_version',
        'systemVersion',
        'SystemVersion',
      ]);
      if (ver) {
        out.push(ver);
      }
    }
    return [...new Set(out)];
  } catch {
    return [];
  }
}
