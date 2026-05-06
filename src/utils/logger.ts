/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
export function debugLog(message: string): void {
  if (process.env.DEVECO_CLI_DEBUG) {
    console.log(`[DEBUG] ${message}`);
  }
}
