/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * 专为打点上报设计的异常类。
 * 允许开发者传入原始错误信息（message）和用于上报的脱敏信息（traceMessage）。
 */
export class TraceError extends Error {
  /**
   * 用于打点上报的异常信息（通常已脱敏）。
   * 若未提供，则默认使用原始 message。
   */
  public readonly traceMessage: string;

  constructor(message: string, traceMessage?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TraceError';
    this.traceMessage = traceMessage ?? message;
  }
}
