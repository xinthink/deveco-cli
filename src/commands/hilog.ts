/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import * as fs from 'fs';
import { ToolProvider } from '../utils/tool-provider.js';
import { HilogAdapter } from '../utils/hilog-adapter.js';
import { blue, green, red } from 'colorette';

const hilogCommand = new Command('log')
  .description('Obtain device application logs')
  .option('--crash', 'Only obtain the crash log')
  .option('--target <device>', 'Target device ID or name')
  .option('--level <level>', 'Log level filtering: D, I, W, E, F')
  .option('--bundle-name <name>', 'Application package name filtering')
  .option('--keyword <pattern>', 'Keyword filtering')
  .action(async (options) => {
    await handleHilogCommand(options);
  });

async function handleHilogCommand(options: Record<string, unknown>) {
  const toolProvider = await ToolProvider.new();
  try {
    const service: HilogAdapter = new HilogAdapter(toolProvider);
    // 设备选择逻辑
    let deviceId = options.hvd as string | undefined;

    if (!deviceId) {
      deviceId = await service.selectDevice();
      if (!deviceId) {
        process.exit(1);
      }
    }

    console.log(blue(`deviceId: ${deviceId}`));
    console.log(blue(`type: ${options.crash ? 'Crash logs' : 'Common logs'}`));

    // 获取日志
    console.log(blue('Obtaining logs ...'));

    let logs: string;
    if (options.crash) {
      logs = await service.getCrashLog(deviceId, options.bundleName as string);
    } else {
      logs = await service.getHilog(deviceId, {
        level: options.level as string,
        tag: options.tag as string,
        domain: options.domain as string,
        bundleName: options.bundleName as string,
        keyword: options.keyword as string,
        logSize: options.logSize as string,
      });
    }

    console.log(green(`Current log: ${logs}`));

    // 输出日志
    if (options.output) {
      fs.writeFileSync(options.output as string, logs);
      console.log(green(`The log has been saved to: ${options.output}`));
    } else {
      console.log(logs);
    }
  } catch (error) {
    console.error(red(`error: ${(error as Error).message}`));
    process.exit(1);
  }
}

export default hilogCommand;
