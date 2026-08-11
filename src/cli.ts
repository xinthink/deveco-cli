#!/usr/bin/env node
/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

process.env.GLOBAL_AGENT_ENVIRONMENT_VARIABLE_NAMESPACE = '';
import { bootstrap } from 'global-agent';
bootstrap();

import * as path from 'path';
import { program, type Command } from 'commander';
import { red } from 'colorette';
import { AgreementConfig } from './auth/auth-config.js';
import buildCommand from './commands/build.js';
import runCommand from './commands/run.js';
import updateCommand from './commands/update.js';
import deviceCommand from './commands/device.js';
import emulatorCommand from './commands/emulator.js';
import authCommand from './commands/auth.js';
import skillsCommand from './commands/skills.js';

import logCommand from './commands/log.js';
import createCommand from './commands/create.js';
import initCommand from './commands/init.js';
import serveCommand from './commands/serve.js';
import docCommand from './commands/doc.js';
import uiCommand from './commands/ui.js';
import checkCommand from './commands/check.js';
import signatureCommand from './commands/signature.js';

import { ToolProvider } from './toolchain/index.js';
import {
  UpdateNotifier,
  getCurrentVersion,
  getUpdateDisableMode,
} from './update/index.js';
import { VersionCache } from './update/version-cache.js';
import { getCliDataDir } from './utils/cli-data-dir.js';

program
  .name('devecocli')
  .description(`HarmonyOS application development command line tool\n\nPrivacy: ${AgreementConfig.PRIVACY_URL}`)
  .version(process.env.npm_package_version || '0.1.0');

program.addCommand(buildCommand);
program.addCommand(runCommand);
program.addCommand(updateCommand);
program.addCommand(deviceCommand);
program.addCommand(emulatorCommand);
program.addCommand(authCommand);

program.addCommand(skillsCommand);
program.addCommand(logCommand);
program.addCommand(createCommand);
program.addCommand(initCommand);
program.addCommand(serveCommand);
program.addCommand(docCommand);
program.addCommand(uiCommand);
program.addCommand(checkCommand);
program.addCommand(signatureCommand);

// Allow `devecocli <command> help` as an alias for `devecocli <command> --help`.
// Commander only supports this automatically for commands that have sub-commands,
// so we normalise it here for leaf commands (build, run, log, etc.) as well.
const rawArgs = process.argv.slice(2);
if (rawArgs.length >= 2 && rawArgs[rawArgs.length - 1] === 'help') {
  process.argv = [...process.argv.slice(0, -1), '--help'];
}

function getTopLevelCommand(command: Command): Command {
  let current = command;
  while (current.parent && current.parent !== program) {
    current = current.parent;
  }
  return current;
}

// Commands that must work without a DevEco Studio toolchain (e.g. `auth` runs
// before the IDE is installed; `update` escapes a blocked/broken release;
// `serve` hosts MCP/LSP and resolves the toolchain internally).
const TOOLCHAIN_FREE_COMMANDS = new Set(['update', 'auth', 'serve']);

program.hook('preAction', async (_thisCommand, actionCommand) => {
  const topLevel = getTopLevelCommand(actionCommand);
  const disableMode = getUpdateDisableMode();

  // `update` bypasses the blocked gate + toolchain check so users can escape
  // a broken release; its own disable policy is enforced in the command.
  if (topLevel.name() === 'update') {
    return;
  }

  // Blocked-version gate: refuse to run recalled / critically broken releases
  // (skipped when the update subsystem is disabled — short-circuits the read).
  const cache = new VersionCache(path.join(getCliDataDir(), 'update'));
  const currentVersion = getCurrentVersion();
  if (
    disableMode === 'off' &&
    cache.getBlockedVersions().includes(currentVersion)
  ) {
    throw new Error(
      `devecocli ${currentVersion} has been disabled, run \`devecocli update\` to upgrade`
    );
  }

  if (process.env.DEVECO_CLI_SKIP_VERSION_CHECK) {
    return;
  }
  if (TOOLCHAIN_FREE_COMMANDS.has(topLevel.name())) {
    return;
  }
  await ToolProvider.checkVersion();
});

program.hook('postAction', async (_thisCommand, actionCommand) => {
  // Skip the upgrade banner when the command failed (soft `exitCode` failure)
  // or the update subsystem is disabled.
  if (process.exitCode || getUpdateDisableMode() !== 'off') {
    return;
  }
  const notifier = new UpdateNotifier(actionCommand);
  await notifier.checkAndNotify();
});

program.parseAsync(process.argv).catch((err) => {
  const message =
    err instanceof Error ? err.message : String(err ?? 'Unknown error');
  console.error(red(`Error: ${message}`));
  if (
    process.env.DEVECO_CLI_DEBUG === '1' &&
    err instanceof Error &&
    err.stack
  ) {
    console.error(err.stack);
  }
  process.exit(1);
});
