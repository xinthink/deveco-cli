/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export class CommonUtils {
  static parsePositiveInteger(value: string, fieldName = 'value'): number {
    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
      throw new Error(`${fieldName} must be a positive integer`);
    }
    return parsedValue;
  }

  static getLastLines(logs: string, lineCount?: number): string {
    if (!lineCount || lineCount <= 0) {
      return logs;
    }

    const lines = logs.split(/\r?\n/);
    return lines.slice(-lineCount).join('\n');
  }
}
