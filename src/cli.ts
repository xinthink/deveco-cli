#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { program } from 'commander';
import buildCommand from './commands/build.js';
import updateCommand from './commands/update.js';

program
  .name('deveco')
  .description('HarmonyOS application development command line tool')
  .version(process.env.npm_package_version || '0.1.0');

program.addCommand(buildCommand);
program.addCommand(updateCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
