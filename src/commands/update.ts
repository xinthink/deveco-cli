/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, cyan } from 'colorette';
import { execa } from 'execa';

function getPackageName(): string {
  return process.env.npm_package_name || 'deveco-cli';
}

const updateCommand = new Command('update')
  .description('Update deveco-cli to the latest version')
  .action(async () => {
    const packageName = getPackageName();
    console.log(cyan(`Updating ${packageName} to the latest version...`));

    try {
      // Execute npm install -g <package-name>@latest
      await execa('npm', ['install', '-g', `${packageName}@latest`], {
        stdio: 'inherit',
      });

      console.log('\n' + green(`${packageName} updated successfully!`));
    } catch (error) {
      const e = error as Error;
      console.error(red(`Failed to update ${packageName}`));
      if (e.message) {
        console.error(red(e.message));
      }
      process.exit(1);
    }
  });

export default updateCommand;
