/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import path from 'path';
import { Command } from 'commander';
import { green, red, cyan } from 'colorette';
import { ToolProvider } from '../utils/tool-provider.js';
import {
  createProject,
  CreateProjectResult,
} from '../utils/template-provider.js';

interface CreateOptions {
  projectPath?: string;
  appName?: string;
  bundleName?: string;
  apiLevel?: string;
}

function deriveBundleName(appName: string): string {
  return `com.example.${appName.toLowerCase()}`;
}

const createCommand = new Command('create')
  .description('Initialize a new application project')
  .option('--project-path <path>', 'Project directory path')
  .option('--app-name <name>', 'Application name')
  .option(
    '--bundle-name <bundle>',
    'Bundle name (auto-derived if not specified)'
  )
  .option('--api-level <level>', 'API level (auto-detected if not specified)')
  .action(async (options: CreateOptions) => {
    try {
      if (!options.projectPath) {
        console.error(red('Error: --project-path is required'));
        process.exit(1);
      }

      if (!options.appName) {
        console.error(red('Error: --app-name is required'));
        process.exit(1);
      }

      const projectPath = path.resolve(options.projectPath);
      const appName = options.appName;
      const bundleName = options.bundleName || deriveBundleName(appName);

      console.log(cyan('Initializing project...'));
      console.log(`Project path: ${projectPath}`);
      console.log(`App name: ${appName}`);
      console.log(`Bundle name: ${bundleName}`);

      const toolProvider = await ToolProvider.new();

      let apiLevel: number;
      let apiLevelSource: string;

      if (options.apiLevel) {
        const parsed = Number(options.apiLevel);
        if (!Number.isInteger(parsed) || parsed < 17 || parsed > 23) {
          console.error(
            red(`Error: Invalid API level ${options.apiLevel}. Must be 17-23`)
          );
          process.exit(1);
        }
        apiLevel = parsed;
        apiLevelSource = 'user_input';
      } else {
        apiLevel = toolProvider.detectApiLevel();
        apiLevelSource = 'auto_detected';
      }

      console.log(`API level: ${apiLevel} (source: ${apiLevelSource})`);

      const result: CreateProjectResult = createProject(
        projectPath,
        appName,
        bundleName,
        apiLevel
      );

      console.log('\n' + green('Project created successfully!'));
      console.log(`Project root: ${result.projectRoot}`);
      console.log(`App name: ${result.appName}`);
      console.log(`Bundle name: ${result.bundleName}`);
      console.log(`API level: ${result.apiLevel}`);
      console.log(green('✓ Template integrity check passed'));
    } catch (error) {
      const e = error as Error;
      console.error(red('\nFailed to create project'));
      console.error(red(e.message));
      process.exit(1);
    }
  });

export default createCommand;
