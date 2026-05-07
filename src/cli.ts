#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { program } from 'commander';
import buildCommand from './commands/build.js';
import updateCommand from './commands/update.js';
import deviceCommand from './commands/device.js';
import emulatorCommand from './commands/emulator.js';
import loginCommand from './commands/login';
import logoutCommand from './commands/logout';
import skillsCommand from './commands/skills.js';
import knowledgeCommand from './commands/knowledge.js';
import hilogCommand from './commands/hilog.js';

program
  .name('deveco')
  .description('HarmonyOS application development command line tool')
  .version(process.env.npm_package_version || '0.1.0');

program.addCommand(buildCommand);
program.addCommand(updateCommand);
program.addCommand(deviceCommand);
program.addCommand(emulatorCommand);
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(knowledgeCommand);
program.addCommand(skillsCommand);
program.addCommand(hilogCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
