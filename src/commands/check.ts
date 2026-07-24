/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { createLintCommand } from '../codelinter/index.js';
import {
  compatCommand,
  handleCheckCommand,
  handleVersionsCommand,
  parseFormat,
  parseLimit,
  readFormatFromArgv,
  type CheckOptions,
} from '../compat/compat.js';

compatCommand
  .description(
    'Check source code compatibility against a target SDK version. ' +
      'By default, performs a project-level scan; pass positional `files...` for file-level scanning; pass `--modules` for module-level scanning.'
  )
  .arguments('[files...]')
  .option(
    '--source-version <version>',
      'Current project SDK version (required; use `compat versions` to list available versions). ' +
      'On zsh, quote the value because version strings contain parentheses; run `compat versions` first to copy a real example.'
  )
  .option(
    '--target-version <version>',
    'Target SDK version (required; use `compat versions` to list available versions). ' +
      'On zsh, quote the value because version strings contain parentheses; run `compat versions` first to copy a real example.'
  )
  .option(
    '--modules <modules...>',
    'Modules to check (default: all modules in the project). Mutually exclusive with positional file arguments.'
  )
  .option(
    '--format <format>',
    'Output format: "json" or "default" (text) for console; "csv", "json", or "default" for file output (--output-path). "csv" requires --output-path.',
    parseFormat,
    'default'
  )
  .option(
    '--output-path <path>',
    'Directory to write the detailed report CSV to (default: ./compat-output)'
  )
  .option(
    '--limit <num>',
    'Maximum number of change records to display (default: 100)',
    parseLimit,
    100
  )
  .action(async (files: string[], options: CheckOptions) => {
    await handleCheckCommand(files, options);
  });

compatCommand
  .command('versions')
  .description(
    'List all available target SDK versions for compatibility checking'
  )
  .action(async () => {
    const format = readFormatFromArgv('csv');
    await handleVersionsCommand(format);
  });

const checkCommand = new Command('check')
  .description('Run DevEco project checks')
  .addCommand(compatCommand)
  .addCommand(createLintCommand());

export default checkCommand;
