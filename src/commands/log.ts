/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, InvalidArgumentError } from 'commander';
import { ToolProvider } from '../utils/tool-provider.js';
import { HilogAdapter } from '../utils/hilog-adapter.js';
import { CommonUtils } from '../utils/common-utils.js';
import { cyan, red } from 'colorette';

interface LogOptions {
  device?: string;
  crash?: boolean;
  level?: string;
  bundleName?: string;
  keyword?: string;
  follow?: boolean;
  tail?: number;
}

function parsePositiveInt(value: string): number {
  try {
    return CommonUtils.parsePositiveInteger(value, 'tail');
  } catch {
    throw new InvalidArgumentError('tail must be a positive integer');
  }
}

const logCommand = new Command('log')
  .description('Obtain device application logs')
  .option('--device <device>', 'Target device (name or serial)')
  .option('--crash', 'Only obtain the crash log')
  .option('--level <level>', 'Log level filter: D, I, W, E, F')
  .option('--bundle-name <bundle-name>', 'Filter by application bundle name')
  .option('--keyword <keyword>', 'Keyword filter')
  .option('--tail <num>', 'Show only the latest N log lines', parsePositiveInt)
  .option('--follow', 'Follow the log stream in real-time.')
  .action(async (options: LogOptions) => {
    await handleLogCommand(options);
  });

async function handleLogCommand(options: LogOptions) {
  try {
    const toolProvider = await ToolProvider.new();
    const service = new HilogAdapter(toolProvider);

    const deviceId = await service.selectDevice(options.device);
    if (!deviceId) {
      process.exit(1);
    }

    console.log(cyan(`deviceId: ${deviceId}`));
    console.log(cyan(`type: ${options.crash ? 'Crash logs' : 'Common logs'}`));
    console.log(cyan('Obtaining logs ...'));

    let logs = options.crash
      ? await service.getCrashLog(deviceId, options.bundleName)
      : await service.getHilog(deviceId, {
          level: options.level,
          bundleName: options.bundleName,
          keyword: options.keyword,
          isFollow: options.follow ? true : false,
          tail: options.tail,
        });

    if (options.crash && options.tail && logs) {
      logs = CommonUtils.getLastLines(logs, options.tail);
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
