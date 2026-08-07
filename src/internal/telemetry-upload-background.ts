/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 *
 * Internal entry for background telemetry upload — spawned by CLI (non-MCP) when
 * isUploadDue() returns true. Not exposed as a CLI subcommand.
 */

import path from 'node:path';
import { getCliDataDir } from '../utils/cli-data-dir.js';
import { telemetry } from '../trace/index.js';
import { mcpLog } from '../../mcp/src-server/utils/mcp-logger.js';

const storageDir = path.join(getCliDataDir(), 'TraceLogData');

telemetry.init(storageDir);
telemetry
  .flush()
  .then((ok) => {
    if (ok) {
      mcpLog.info('[telemetry] background upload completed');
    } else {
      mcpLog.warn('[telemetry] background upload completed with failures');
    }
  })
  .catch((e) => {
    mcpLog.error('[telemetry] background upload error:', e);
    process.exit(1);
  });
