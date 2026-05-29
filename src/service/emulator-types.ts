/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/** Emulator row from `emulator -list -details` (JSON or text). */
export interface EmulatorInfo {
  name: string;
  isRunning?: boolean;
  instancePath?: string;
  path?: string;
  imageRoot?: string;
  /** From `-list -details` when present; CLI target for some images */
  uuid?: string;
  deviceType?: string;
  osVersion?: string;
}

/** Match CLI input to `-list` names (unicode / repeated spaces). */
export function normalizeListNameKey(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, ' ').trim();
}
