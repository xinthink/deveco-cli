/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { debugLog } from './logger';

export class CommonUtils {
  private static readonly ASCII_CONTROL_MAX = 31;
  private static readonly ASCII_DELETE = 127;

  // 解析正整数（用于 tail 等参数校验）
  static parsePositiveInteger(value: string, fieldName = 'value'): number {
    const normalizedValue = value.trim();
    if (!/^\d+$/.test(normalizedValue)) {
      throw new Error(`${fieldName} must be a positive integer`);
    }
    const parsedValue = Number.parseInt(normalizedValue, 10);
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

  static parseDurationToSeconds(value: string, fieldName = 'value'): number {
    // 支持形如 30s / 5m / 2.5m / 120（默认秒）
    const normalizedValue = value.trim().toLowerCase();
    const match = normalizedValue.match(/^(\d+(?:\.\d+)?)([sm])?$/);
    if (!match) {
      throw new Error(
        `${fieldName} must be like 30s, 5m or 2.5m (only s/m supported)`
      );
    }

    const rawAmount = match[1];
    const unit = match[2] ?? 's';

    // 秒和默认单位必须是纯整数；分钟允许最多 1 位小数
    if (unit === 's') {
      return CommonUtils.parsePositiveInteger(rawAmount, fieldName);
    }

    if (!/^\d+(?:\.\d)?$/.test(rawAmount)) {
      throw new Error(
        `${fieldName} minute value supports at most one decimal place, e.g. 2.5m`
      );
    }

    const minuteValue = Number.parseFloat(rawAmount);
    if (!Number.isFinite(minuteValue) || minuteValue <= 0) {
      throw new Error(`${fieldName} must be a positive duration`);
    }

    return Math.round(minuteValue * 60);
  }

  static assertRelativeTimeRange(
    fromSeconds?: number,
    toSeconds?: number
  ): void {
    if (
      fromSeconds !== undefined &&
      toSeconds !== undefined &&
      fromSeconds < toSeconds
    ) {
      throw new Error(
        '--from must be greater than or equal to --to when both are provided (e.g. --from 30s --to 10s)'
      );
    }
  }

  static filterLogsByRelativeWindow(
    logs: string,
    fromSeconds?: number,
    toSeconds?: number,
    now: Date = new Date()
  ): string {
    // 未指定时间窗口时直接返回原始日志
    if (!fromSeconds && !toSeconds) {
      return logs;
    }

    const [lowerBound, upperBound] = CommonUtils.resolveTimeBounds(
      fromSeconds,
      toSeconds,
      now
    );

    const lines = logs.split(/\r?\n/);
    const keptLines: string[] = [];
    let includeCurrentBlock = false;

    for (const line of lines) {
      // 当检测到新时间戳行时，更新当前日志块是否命中窗口
      const lineTime = CommonUtils.extractTimestampFromLogLine(line, now);
      if (lineTime) {
        includeCurrentBlock = CommonUtils.isWithinBounds(
          lineTime,
          lowerBound,
          upperBound
        );
      }

      if (includeCurrentBlock) {
        // 延续上一条命中的日志块，保留后续无时间戳的堆栈/多行内容
        keptLines.push(line);
      }
    }

    return keptLines.join('\n');
  }

  private static resolveTimeBounds(
    fromSeconds: number | undefined,
    toSeconds: number | undefined,
    now: Date
  ): [Date | null, Date | null] {
    // from / to 都是“相对当前时间往前偏移”的秒数
    const fromTime = fromSeconds
      ? new Date(now.getTime() - fromSeconds * 1000)
      : null;
    const toTime = toSeconds
      ? new Date(now.getTime() - toSeconds * 1000)
      : null;

    if (fromTime && toTime) {
      // 自动归一化顺序，兼容 --from 30s --to 30m 这种输入
      return fromTime < toTime ? [fromTime, toTime] : [toTime, fromTime];
    }

    if (fromTime) {
      return [fromTime, now];
    }

    if (toTime) {
      return [null, toTime];
    }

    return [null, null];
  }

  private static isWithinBounds(
    timestamp: Date,
    lowerBound: Date | null,
    upperBound: Date | null
  ): boolean {
    const timestampMs = timestamp.getTime();
    const lowerBoundMs = lowerBound
      ? Math.floor(lowerBound.getTime() / 1000) * 1000
      : null;
    const upperBoundMs = upperBound
      ? Math.floor(upperBound.getTime() / 1000) * 1000 + 999
      : null;

    if (lowerBoundMs !== null && timestampMs < lowerBoundMs) {
      return false;
    }
    if (upperBoundMs !== null && timestampMs > upperBoundMs) {
      return false;
    }
    return true;
  }

  private static extractTimestampFromLogLine(
    line: string,
    referenceNow: Date
  ): Date | null {
    // 兼容常见 hilog 时间格式：MM-DD HH:mm:ss(.SSS...)
    const match = line.match(
      /(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/
    );
    if (!match) {
      return null;
    }

    const year = referenceNow.getFullYear();
    const month = Number.parseInt(match[1], 10) - 1;
    const day = Number.parseInt(match[2], 10);
    const hour = Number.parseInt(match[3], 10);
    const minute = Number.parseInt(match[4], 10);
    const second = Number.parseInt(match[5], 10);
    const milliRaw = match[6] ?? '0';
    const millisecond = Number.parseInt(
      milliRaw.padEnd(3, '0').slice(0, 3),
      10
    );

    const candidate = new Date(
      year,
      month,
      day,
      hour,
      minute,
      second,
      millisecond
    );

    // 跨年保护：若解析结果明显“晚于当前时间”，则回退到上一年
    if (candidate.getTime() > referenceNow.getTime() + 24 * 60 * 60 * 1000) {
      candidate.setFullYear(year - 1);
    }

    return candidate;
  }

  static assertBundleName(name: string): void {
    // 只允许字母/数字/下划线/点，长度 1-128
    if (!/^[A-Za-z0-9_.]{1,128}$/.test(name)) {
      throw new Error(`Invalid bundleName: ${JSON.stringify(name)}`);
    }
  }

  static assertHilogToken(value: string, field: string): void {
    // 只允许字母/数字/下划线/点/冒号/连字符，长度 1-64
    if (!/^[A-Za-z0-9_.:\\-]{1,64}$/.test(value)) {
      throw new Error(`Invalid ${field}: ${JSON.stringify(value)}`);
    }
  }

  static assertHilogKeyword(value: string): void {
    if (value.length === 0 || value.length > 128) {
      throw new Error(`Invalid keyword: ${JSON.stringify(value)}`);
    }

    // 关键字会作为字符串传入 shell 命令（通过 quotePosixShellArg 做安全包裹）。
    // 这里只拒绝控制字符，避免命令截断、跨行注入或不可见字符带来的解析歧义。
    const hasControlChar = [...value].some((char) => {
      const code = char.charCodeAt(0);
      return (
        code <= CommonUtils.ASCII_CONTROL_MAX ||
        code === CommonUtils.ASCII_DELETE
      );
    });
    if (hasControlChar) {
      throw new Error(`Invalid keyword: ${JSON.stringify(value)}`);
    }
  }

  static quotePosixShellArg(value: string): string {
    // 用单引号包裹，内部单引号用 '\'' 转义（结束引号、转义单引号、重新开引号）
    const escaped = value.replace(/'/g, "'\\''");
    const result = `'${escaped}'`;
    debugLog(`quotePosixShellArg: ${value} -> ${result}`);
    return result;
  }

  static assertCrashFilename(name: string): void {
    // 匹配faultLog名称，比如 jscrash-com.example.myapplication-20020059-20260512170652
    const crashFilenameRegExp = /^\w+-.+\d+-\d+$/;
    if (!crashFilenameRegExp.test(name)) {
      throw new Error(`Invalid crash log filename: ${JSON.stringify(name)}`);
    }
  }

  static assertHilogLevel(level: string): void {
    if (!/^[DIWEF]$/.test(level)) {
      throw new Error(`Invalid log level: ${level}`);
    }
  }
}
