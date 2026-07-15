/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export function normalizeEnvPath(value: string): string {
  let normalized = value.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (normalized.split(/[/\\]+/).some((segment) => segment === '..')) {
    throw new Error('Path must not contain traversal segments (..).');
  }
  const trimmed = normalized.replace(/[/\\]+$/, '');
  return trimmed.length > 0 ? trimmed : normalized;
}
