/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const initScript = join(root, 'dist', 'internal', 'doc-init-background.js');

if (!existsSync(initScript)) {
  process.exit(0);
}

const child = spawn(process.execPath, [initScript], {
  detached: true,
  stdio: ['ignore', 'ignore', 'ignore'],
  env: {
    ...process.env,
    DEVECO_CLI_SKIP_VERSION_CHECK: '1',
    DEVECO_CLI_POSTINSTALL: '1',
  },
});

child.unref();
process.exit(0);
