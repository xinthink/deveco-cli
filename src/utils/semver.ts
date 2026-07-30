/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { compare } from 'semver';

/**
 * Compare two SemVer strings (incl. pre-release precedence). Returns negative
 * if left < right, positive if left > right, 0 if equal. Throws on malformed
 * versions — callers should guard or wrap in try/catch.
 */
export function compareVersions(left: string, right: string): number {
  return compare(left, right);
}

/**
 * Compare numeric dot-separated versions of 2–4 segments (e.g. "6.1.0.123").
 * Used for DevEco Studio build versions, which are not strict SemVer (a 4th
 * numeric build segment) and would be rejected by `semver.compare`.
 */
export function compareNumericVersions(left: string, right: string): number {
  const length = Math.max(left.split('.').length, right.split('.').length);
  for (let index = 0; index < length; index++) {
    const diff =
      Number(left.split('.')[index] ?? 0) -
      Number(right.split('.')[index] ?? 0);
    if (diff) {
      return diff;
    }
  }
  return 0;
}
