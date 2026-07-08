/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { homedir } from 'os';
import { join } from 'path';

const APP_NAME = 'deveco-cli';

export function getDocInitLogDir() {
  return join(homedir(), '.local', 'share', APP_NAME, 'logs');
}

export function getDocInitLogPath() {
  return process.env.DEVECO_DOC_INIT_LOG ?? join(getDocInitLogDir(), 'doc-init.log');
}
