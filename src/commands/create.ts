/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import path from 'path';
import fs from 'fs';
import process from 'process';
import { Command } from 'commander';
import { green, red, cyan, yellow } from 'colorette';
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

function resolveProjectPath(appName: string, specifiedPath?: string): string {
  if (specifiedPath) {
    const resolvedPath = path.resolve(specifiedPath);
    if (fs.existsSync(resolvedPath)) {
      const contents = fs.readdirSync(resolvedPath);
      if (contents.length > 0) {
        throw new Error(
          `Directory '${resolvedPath}' is not empty. Cannot create project in non-empty directory.`
        );
      }
    }
    return resolvedPath;
  }

  const pwd = process.cwd();
  const basePath = path.join(pwd, appName);

  if (!fs.existsSync(basePath)) {
    return basePath;
  }

  let counter = 1;
  let candidatePath = path.join(pwd, `${appName}_${counter}`);

  while (fs.existsSync(candidatePath) && counter < 100) {
    counter++;
    candidatePath = path.join(pwd, `${appName}_${counter}`);
  }

  if (counter >= 100) {
    throw new Error(
      `Too many directories with name '${appName}' exist. Manual cleanup required.`
    );
  }

  console.log(
    yellow(
      `Directory '${appName}' already exists. Using '${appName}_${counter}'`
    )
  );

  return candidatePath;
}

function resolveApiLevel(
  options: CreateOptions,
  toolProvider?: ToolProvider
): { apiLevel: number; source: string } {
  if (options.apiLevel) {
    const parsed = Number(options.apiLevel);
    if (!Number.isInteger(parsed) || parsed < 17 || parsed > 23) {
      throw new Error(`Invalid API level ${options.apiLevel}. Must be 17-23`);
    }
    return { apiLevel: parsed, source: 'user_input' };
  }

  if (toolProvider) {
    return { apiLevel: toolProvider.detectApiLevel(), source: 'auto_detected' };
  }

  return { apiLevel: 23, source: 'default_fallback' };
}

async function tryGetToolProvider(): Promise<ToolProvider | undefined> {
  try {
    return await ToolProvider.new();
  } catch (error) {
    const e = error as Error;
    console.log(yellow(`DevEco Studio not found: ${e.message}`));
    console.log(yellow('Using placeholder images instead.'));
    return undefined;
  }
}

const createCommand = new Command('create')
  .description('Initialize a new application project')
  .option(
    '--project-path <path>',
    'Project directory path (default: pwd/<app-name>)'
  )
  .option('--app-name <name>', 'Application name')
  .option(
    '--bundle-name <bundle>',
    'Bundle name (auto-derived if not specified)'
  )
  .option('--api-level <level>', 'API level (auto-detected if not specified)')
  .action(async (options: CreateOptions) => {
    try {
      if (!options.appName) {
        console.error(red('Error: --app-name is required'));
        process.exit(1);
      }

      const appName = options.appName;
      const bundleName = options.bundleName || deriveBundleName(appName);
      const projectPath = resolveProjectPath(appName, options.projectPath);

      console.log(cyan('Initializing project...'));
      console.log(`Project path: ${projectPath}`);
      console.log(`App name: ${appName}`);
      console.log(`Bundle name: ${bundleName}`);

      const toolProvider = await tryGetToolProvider();
      const { apiLevel, source } = resolveApiLevel(options, toolProvider);
      console.log(`API level: ${apiLevel} (source: ${source})`);

      const devecoStudioPath = toolProvider?.devecoStudioPath;

      const result: CreateProjectResult = createProject(
        projectPath,
        appName,
        bundleName,
        apiLevel,
        devecoStudioPath
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
