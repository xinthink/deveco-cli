/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { join } from 'path';
import { getCliDataDir } from './cli-data-dir.mjs';

export function getDocInitLogDir() {
  return join(getCliDataDir(), 'logs');
}

export function getDocInitLogPath() {
  return join(getDocInitLogDir(), 'doc-init.log');
}
