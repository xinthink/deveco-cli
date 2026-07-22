/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface ExitHandler {
  exit(code: number): never;
}

export const processExitHandler: ExitHandler = {
  exit(code: number): never {
    process.exit(code);
  },
};
