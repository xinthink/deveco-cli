/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, InvalidArgumentError } from 'commander';
import { ToolProvider } from '../utils/tool-provider.js';
import { HilogAdapter } from '../utils/hilog-adapter.js';
import { CommonUtils } from '../utils/common-utils.js';
import { cyan, red } from 'colorette';
import { debugLog } from '../utils/logger.js';

interface LogOptions {
  device?: string;
  crash?: boolean;
  level?: string;
  bundleName?: string;
  keyword?: string;
  follow?: boolean;
  tail?: number;
  from?: number;
  to?: number;
}

function parsePositiveInt(value: string): number {
  try {
    return CommonUtils.parsePositiveInteger(value, 'tail');
  } catch {
    throw new InvalidArgumentError('tail must be a positive integer');
  }
}

function parseDuration(value: string, fieldName: string): number {
  try {
    return CommonUtils.parseDurationToSeconds(value, fieldName);
  } catch {
    throw new InvalidArgumentError(
      `${fieldName} must be like 30s, 5m or 2.5m (s/m only; seconds/default must be integers)`
    );
  }
}

function validateLogTimeRange(options: LogOptions): void {
  if (options.to && options.follow) {
    throw new Error('--to cannot be used with --follow');
  }

  CommonUtils.assertRelativeTimeRange(options.from, options.to);
}

const logCommand = new Command('log')
  .description('Obtain device application logs')
  .configureOutput({
    outputError: (str, write) => write(red(str)),
  })
  .option('--device <device>', 'Target device (name or serial)')
  .option('--crash', 'Only obtain the crash log')
  .option('--level <level>', 'Log level filter: D, I, W, E, F')
  .option('--bundle-name <bundle-name>', 'Filter by application bundle name')
  .option('--keyword <keyword>', 'Keyword filter')
  .option('--tail <num>', 'Show only the latest N log lines', parsePositiveInt)
  .option(
    '--from <start>',
    'Start offset from now, e.g. 30s, 5m, 2.5m, or 120',
    (value: string) => parseDuration(value, 'from')
  )
  .option(
    '--to <end>',
    'End offset from now, e.g. 30s, 5m, 2.5m, or 120',
    (value: string) => parseDuration(value, 'to')
  )
  .option('--follow', 'Follow the log stream in real-time.')
  .action(async (options: LogOptions) => {
    await handleLogCommand(options);
  });

async function handleLogCommand(options: LogOptions) {
  try {
    validateLogTimeRange(options);
    const fromSeconds = options.from;
    const toSeconds = options.to;

    const toolProvider = await ToolProvider.new();
    const service = new HilogAdapter(toolProvider);

    const deviceId = await service.selectDevice(options.device);
    if (!deviceId) {
      process.exit(1);
    }

    debugLog(cyan(`deviceId: ${deviceId}`));
    debugLog(cyan(`type: ${options.crash ? 'Crash logs' : 'Common logs'}`));
    debugLog(cyan('Obtaining logs ...'));

    let logs = options.crash
      ? await service.getCrashLog(deviceId, options.bundleName)
      : await service.getHilog(deviceId, {
          level: options.level,
          bundleName: options.bundleName,
          keyword: options.keyword,
          isFollow: options.follow ? true : false,
          tail: options.tail,
          fromSeconds,
          toSeconds,
        });

    if (options.crash && logs) {
      logs = CommonUtils.filterLogsByRelativeWindow(
        logs,
        fromSeconds,
        toSeconds
      );
      if (options.tail) {
        logs = CommonUtils.getLastLines(logs, options.tail);
      }
    }

    if (logs) {
      console.log(logs);
    }
  } catch (error) {
    console.error(red((error as Error).message));
    process.exit(1);
  }
}

export default logCommand;
