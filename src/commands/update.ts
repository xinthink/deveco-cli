/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, cyan } from 'colorette';
import { execa } from 'execa';

function getPublishTag(): string {
  return process.env.npm_config_tag || 'latest';
}

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
    const publishTag = getPublishTag();

    console.log(cyan(`Checking for updates...`));

    try {
      // Get the tagged version from npm registry
      const { stdout: latestVersion } = await execa('npm', [
        'view',
        packageName,
        `dist-tags.${publishTag}`,
      ]);
      const latest = latestVersion.trim();

      if (!latest || latest === currentVersion) {
        console.log(
          green(
            `\n${packageName} is already up to date (v${currentVersion}, tag: ${publishTag})`
          )
        );
        return;
      }

      console.log(
        cyan(`\nNew version found: ${latest} (current: ${currentVersion})`)
      );
      console.log(cyan(`Updating ${packageName}...`));

      // Execute npm install -g <package-name>@<tag>
      await execa('npm', ['install', '-g', `${packageName}@${publishTag}`], {
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
