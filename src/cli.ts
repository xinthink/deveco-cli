#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

process.env.GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE = '';
import { bootstrap } from 'global-agent';
bootstrap();

import { program } from 'commander';
import buildCommand from './commands/build.js';
import runCommand from './commands/run.js';
import updateCommand from './commands/update.js';
import deviceCommand from './commands/device.js';
import emulatorCommand from './commands/emulator.js';
import loginCommand from './commands/login';
import logoutCommand from './commands/logout';
import whoamiCommand from './commands/whoami';
import skillsCommand from './commands/skills.js';
import knowledgeCommand from './commands/knowledge.js';
import logCommand from './commands/log.js';
import createCommand from './commands/create.js';
import initCommand from './commands/init.js';

program
  .name('deveco')
  .description('HarmonyOS application development command line tool')
  .version(process.env.npm_package_version || '0.1.0');

program.addCommand(buildCommand);
program.addCommand(runCommand);
program.addCommand(updateCommand);
program.addCommand(deviceCommand);
program.addCommand(emulatorCommand);
program.addCommand(loginCommand);
program.addCommand(logoutCommand);
program.addCommand(whoamiCommand);
program.addCommand(knowledgeCommand);
program.addCommand(skillsCommand);
program.addCommand(logCommand);
program.addCommand(createCommand);
program.addCommand(initCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
