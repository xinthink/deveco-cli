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

function getCurrentVersion(): string {
  return process.env.npm_package_version || '0.0.1';
}

const updateCommand = new Command('update')
  .description('Update deveco-cli to latest')
  .action(async () => {
    const packageName = getPackageName();
    const currentVersion = getCurrentVersion();

    console.log(cyan(`Checking for updates...`));

    try {
      // Get the latest version from npm registry
      const { stdout: latestVersion } = await execa('npm', [
        'view',
        packageName,
        'version',
      ]);
      const latest = latestVersion.trim();

      if (latest === currentVersion) {
        console.log(
          green(
            `\n${packageName} is already up to date (version ${currentVersion}.)`
          )
        );
        return;
      }

      console.log(
        cyan(`\nNew version found: ${latest} (current: ${currentVersion})`)
      );
      console.log(cyan(`Updating ${packageName}...`));

      // Execute npm install -g <package-name>@latest
      await execa('npm', ['install', '-g', `${packageName}@latest`], {
        stdio: 'inherit',
      });

      console.log(
        '\n' +
          green(`${packageName} updated successfully to version ${latest}.`)
      );
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
