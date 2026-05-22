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

export interface DownloadedImageEntry {
  osVersion: string;
  softwareVersion: string;
  deviceType: string;
}

function isDownloadedTrue(obj: Record<string, unknown>): boolean {
  const d = obj.downloaded ?? obj.Downloaded;
  return d === true || String(d).toLowerCase() === 'true';
}

function parseDownloadedEntry(
  row: Record<string, unknown>
): DownloadedImageEntry | null {
  if (!isDownloadedTrue(row)) {
    return null;
  }
  const osVersion = pickString(row, [
    'osVersion',
    'OsVersion',
    'OSVersion',
  ]);
  const softwareVersion = pickString(row, [
    'SoftWareVersion',
    'SoftwareVersion',
    'softwareVersion',
  ]);
  const deviceType = pickString(row, ['deviceType', 'DeviceType']);
  if (!osVersion && !softwareVersion) {
    return null;
  }
  return {
    osVersion,
    softwareVersion,
    deviceType,
  };
}

export function parseDownloadedImageEntriesFromImageList(
  stdout: string
): DownloadedImageEntry[] {
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  try {
    const data = JSON.parse(text) as unknown;
    if (!Array.isArray(data)) {
      return [];
    }
    const out: DownloadedImageEntry[] = [];
    for (const item of data) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const parsed = parseDownloadedEntry(item as Record<string, unknown>);
      if (parsed) {
        out.push(parsed);
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function parseDownloadedOsVersionsFromImageList(
  stdout: string
): string[] {
  const entries = parseDownloadedImageEntriesFromImageList(stdout);
  const out = entries.map((entry) => entry.osVersion).filter(Boolean);
  return [...new Set(out)];
}
