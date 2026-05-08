/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { ToolProvider } from '../utils/tool-provider.js';
import { HilogAdapter } from '../utils/hilog-adapter.js';
import { blue, red } from 'colorette';

interface LogOptions {
  device?: string;
  crash?: boolean;
  level?: string;
  bundleName?: string;
  keyword?: string;
}

const logCommand = new Command('log')
  .description('Obtain device application logs')
  .option('-d, --device <device>', 'Target device (name or serial)')
  .option('--crash', 'Only obtain the crash log')
  .option('--level <level>', 'Log level filter: D, I, W, E, F')
  .option('--bundle-name <bundle-name>', 'Filter by application bundle name')
  .option('--keyword <pattern>', 'Keyword filter')
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

    console.log(blue(`deviceId: ${deviceId}`));
    console.log(blue(`type: ${options.crash ? 'Crash logs' : 'Common logs'}`));
    console.log(blue('Obtaining logs ...'));

    const logs = options.crash
      ? await service.getCrashLog(deviceId, options.bundleName)
      : await service.getHilog(deviceId, {
          level: options.level,
          bundleName: options.bundleName,
          keyword: options.keyword,
        });

    console.log(logs);
  } catch (error) {
    console.error(red(`error: ${(error as Error).message}`));
    process.exit(1);
  }
}

export default logCommand;
