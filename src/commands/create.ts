/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, cyan } from 'colorette';
import { execa } from 'execa';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

interface CreateOptions {
  projectPath?: string;
  appName?: string;
  bundleName?: string;
  apiLevel?: string;
}

function getProjectRoot(): string {
  const currentFileUrl = import.meta.url;
  const currentFilePath = fileURLToPath(currentFileUrl);

  if (currentFilePath.includes('dist')) {
    return path.dirname(path.dirname(currentFilePath));
  }

  const commandsDir = path.dirname(currentFilePath);
  const srcDir = path.dirname(commandsDir);
  return path.dirname(srcDir);
}

function getScriptDir(): string {
  return path.join(getProjectRoot(), 'scripts');
}

function getTemplateDir(): string {
  return path.join(getProjectRoot(), 'templates', 'application');
}

function deriveBundleName(appName: string): string {
  return `com.example.${appName.toLowerCase()}`;
}

async function verifyProject(projectRoot: string): boolean {
  const buildProfile = path.join(projectRoot, 'build-profile.json5');
  return fs.existsSync(buildProfile);
}

const createCommand = new Command('create')
  .description('Create a new HarmonyOS project')
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

      console.log(cyan('Creating HarmonyOS project...'));
      console.log(`Project path: ${projectPath}`);
      console.log(`App name: ${appName}`);
      console.log(`Bundle name: ${bundleName}`);

      const scriptPath = path.join(getScriptDir(), 'copy-template.mjs');
      const templateDir = getTemplateDir();

      const args = [
        '--project-path',
        projectPath,
        '--app-name',
        appName,
        '--bundle-name',
        bundleName,
        '--template-dir',
        templateDir,
      ];

      if (options.apiLevel) {
        args.push('--api-level', options.apiLevel);
      }

      const result = await execa('node', [scriptPath, ...args], {
        stdio: 'pipe',
      });

      if (result.stdout) {
        const projectInfo = JSON.parse(result.stdout);
        const projectRoot = projectInfo.projectRoot;

        console.log('\n' + green('Project created successfully!'));
        console.log(`Project root: ${projectRoot}`);
        console.log(`App name: ${projectInfo.appName}`);
        console.log(`Bundle name: ${projectInfo.bundleName}`);
        console.log(
          `API level: ${projectInfo.apiLevel} (source: ${projectInfo.source})`
        );

        if (projectInfo.detectedFrom) {
          console.log(`Detected from: ${projectInfo.detectedFrom}`);
        }

        if (await verifyProject(projectRoot)) {
          console.log(green('✓ Template integrity check passed'));
        } else {
          console.log(red('✗ Template integrity check failed'));
        }
      }
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string };
      console.error(red('\nFailed to create project'));
      if (e.stderr) {
        console.error(red(e.stderr));
      } else {
        console.error(red(e.message));
      }
      process.exit(1);
    }
  });

export default createCommand;
