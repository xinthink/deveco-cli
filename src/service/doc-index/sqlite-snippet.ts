/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export function extractSearchSnippet(content: string, query: string, maxLen = 200): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) {
    return normalized;
  }

  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  let bestIndex = 0;
  for (const token of tokens) {
    const idx = normalized.toLowerCase().indexOf(token.toLowerCase());
    if (idx >= 0) {
      bestIndex = idx;
      break;
    }
  }

  const start = Math.max(0, bestIndex - 40);
  const end = Math.min(normalized.length, start + maxLen);
  const snippet = normalized.slice(start, end).trim();
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalized.length ? '...' : '';
  return `${prefix}${snippet}${suffix}`;
}
