/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 *
 * Internal entry for postinstall only — not exposed as a CLI subcommand.
 */

import { DocInitializer } from '../service/doc-initializer.js';

const builtBy = process.env.DEVECO_CLI_POSTINSTALL ? 'postinstall' : 'doc-init';

DocInitializer.run({ background: true, builtBy }).catch(() => {
  process.exit(1);
});
