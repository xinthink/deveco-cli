#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

process.env.GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE = '';
import { bootstrap } from 'global-agent';
bootstrap();

import { program } from 'commander';
import { red } from 'colorette';
import buildCommand from './commands/build.js';
import runCommand from './commands/run.js';
import updateCommand from './commands/update.js';
import deviceCommand from './commands/device.js';
import emulatorCommand from './commands/emulator.js';
import uiCommand from './commands/ui.js';
import skillsCommand from './commands/skills.js';

import logCommand from './commands/log.js';
import createCommand from './commands/create.js';
import initCommand from './commands/init.js';
import serveCommand from './commands/serve.js';
import docCommand from './commands/doc.js';
import { ToolProvider } from './utils/tool-provider.js';

program
  .name('devecocli')
  .description('HarmonyOS application development command line tool')
  .version(process.env.npm_package_version || '0.1.0');

program.addCommand(buildCommand);
program.addCommand(runCommand);
program.addCommand(updateCommand);
program.addCommand(deviceCommand);
program.addCommand(emulatorCommand);
program.addCommand(uiCommand);

program.addCommand(skillsCommand);
program.addCommand(logCommand);
program.addCommand(createCommand);
program.addCommand(initCommand);
program.addCommand(serveCommand);
program.addCommand(docCommand);

// Allow `devecocli <command> help` as an alias for `devecocli <command> --help`.
// Commander only supports this automatically for commands that have sub-commands,
// so we normalise it here for leaf commands (build, run, log, etc.) as well.
const rawArgs = process.argv.slice(2);
if (rawArgs.length >= 2 && rawArgs[rawArgs.length - 1] === 'help') {
  process.argv = [...process.argv.slice(0, -1), '--help'];
}
const TOOLCHAIN_FREE_COMMANDS = new Set(['update']);

// Use `preAction` (not `preSubcommand`) so `-h` / `--help` on any subcommand
program.hook('preAction', async (_thisCommand, actionCommand) => {
  if (process.env.DEVECO_CLI_SKIP_VERSION_CHECK) {
    return;
  }
  let topLevel = actionCommand;
  while (topLevel.parent && topLevel.parent !== program) {
    topLevel = topLevel.parent;
  }
  if (TOOLCHAIN_FREE_COMMANDS.has(topLevel.name())) {
    return;
  }
  await ToolProvider.checkVersion();
});

program.parseAsync(process.argv).catch((err) => {
  const message =
    err instanceof Error ? err.message : String(err ?? 'Unknown error');
  console.error(red(`Error: ${message}`));
  if (process.env.DEVECO_CLI_DEBUG === '1' && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
