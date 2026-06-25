/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import path from 'path';
import fs from 'fs';
import process from 'process';
import os from 'os';
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

function validateAppName(name: string): void {
  if (name.length < 1 || name.length > 200) {
    throw new Error(
      `App name length must be 1-200 characters. Current: ${name.length}`
    );
  }

  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(
      'Application name must start with a letter (a-z, A-Z) and contain only letters, digits, and underscores'
    );
  }
}

function validateBundleName(bundleName: string): void {
  if (bundleName.length < 7 || bundleName.length > 128) {
    throw new Error(
      `Bundle name length must be 7-128 characters. Current: ${bundleName.length}`
    );
  }

  if (bundleName.includes('..')) {
    throw new Error(
      'Bundle name cannot contain consecutive dots (e.g., "com..example").'
    );
  }

  const segments = bundleName.split('.');
  if (segments.length < 3) {
    throw new Error(
      'Bundle name must contain at least 3 dot-separated segments.'
    );
  }

  const segmentRegex = /^[a-zA-Z0-9_]+$/;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    if (!segmentRegex.test(segment)) {
      throw new Error(
        `Segment "${segment}" contains invalid characters. Only letters, digits, and underscores allowed.`
      );
    }

    if (i === 0) {
      if (!/^[a-zA-Z]/.test(segment)) {
        throw new Error(
          `First segment "${segment}" must start with a letter (a-z, A-Z).`
        );
      }
    } else {
      if (!/^[a-zA-Z0-9]/.test(segment)) {
        throw new Error(
          `Segment "${segment}" must start with a letter or digit.`
        );
      }
    }

    if (!/[a-zA-Z0-9]$/.test(segment)) {
      throw new Error(`Segment "${segment}" must end with a letter or digit.`);
    }
  }
}

function normalizeProjectPath(projectPath: string): string {
  const platform = os.platform();
  if (platform === 'win32') {
    let normalized = projectPath.replace(/\\/g, '/');
    normalized = normalized.replace(/\/+/g, '/');
    return normalized;
  }
  return projectPath.replace(/\/+/g, '/');
}

function validateProjectPath(projectPath: string): void {
  if (projectPath.length === 0) {
    throw new Error('Project path cannot be empty.');
  }

  if (projectPath.length > 120) {
    throw new Error(
      `Project path cannot exceed 120 characters (current: ${projectPath.length}).`
    );
  }

  const platform = os.platform();

  const rawValidRegex =
    platform === 'win32' ? /^[a-zA-Z0-9._\-:\\/]+$/ : /^[a-zA-Z0-9._\-/]+$/;

  if (!rawValidRegex.test(projectPath)) {
    const allowedChars =
      platform === 'win32'
        ? 'letters, digits, dots, underscores, hyphens, colons, slashes (/) or backslashes (\\)'
        : 'letters, digits, dots, underscores, hyphens or slashes (/)';
    throw new Error(`Project path can only contain ${allowedChars}.`);
  }

  const normalizedPath = normalizeProjectPath(projectPath);

  const chineseRegex = /[\u4e00-\u9fff]/;
  if (chineseRegex.test(normalizedPath)) {
    throw new Error('Project path cannot contain Chinese characters.');
  }

  if (normalizedPath.endsWith('.')) {
    throw new Error('Project path cannot end with a dot (.)');
  }
}

function findExistingParent(dirPath: string): string | null {
  let currentPath = dirPath;
  const root = path.parse(dirPath).root;

  while (currentPath !== root) {
    if (fs.existsSync(currentPath)) {
      return currentPath;
    }
    currentPath = path.dirname(currentPath);
  }

  if (fs.existsSync(root)) {
    return root;
  }

  return null;
}

function checkWritePermission(dirPath: string): void {
  const existingParent = findExistingParent(dirPath);

  if (!existingParent) {
    throw new Error(
      `No existing parent directory found for '${dirPath}'. Cannot create project directory.`
    );
  }

  try {
    fs.accessSync(existingParent, fs.constants.W_OK);
  } catch {
    throw new Error(
      `No write permission for directory '${existingParent}'. Cannot create project here.`
    );
  }

  const testFile = path.join(
    existingParent,
    `.deveco_write_test_${Date.now()}`
  );
  try {
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
  } catch {
    throw new Error(
      `No write permission for directory '${existingParent}'. Cannot create project here.`
    );
  }
}

function deriveBundleName(appName: string): string {
  return `com.example.${appName.toLowerCase()}`;
}

function resolveProjectPath(appName: string, specifiedPath?: string): string {
  if (specifiedPath) {
    const normalizedPath = normalizeProjectPath(specifiedPath);
    const resolvedPath = path.resolve(normalizedPath);
    if (fs.existsSync(resolvedPath)) {
      const contents = fs.readdirSync(resolvedPath);
      if (contents.length > 0) {
        throw new Error(
          `Directory '${resolvedPath}' is not empty. Cannot create project here.`
        );
      }
    } else {
      checkWritePermission(resolvedPath);
    }
    return resolvedPath;
  }

  const pwd = process.cwd();
  const basePath = path.join(pwd, appName);

  if (fs.existsSync(basePath)) {
    throw new Error(
      `Directory '${basePath}' already exists. Cannot create project here.`
    );
  }

  checkWritePermission(basePath);
  return basePath;
}

function resolveApiLevel(
  options: CreateOptions,
  toolProvider?: ToolProvider
): number {
  const sdkMaxApi = toolProvider?.getMaxApiLevel(); // 有 IDE 时从 SDK 获取，无 IDE 时 undefined
  const noIdeMaxApi = 23; // 无 IDE 时的默认上限

  if (options.apiLevel) {
    const parsed = Number(options.apiLevel);
    
    // 最小 API 验证：API 版本从 17 开始
    if (!Number.isInteger(parsed) || parsed < 17) {
      throw new Error(
        `Invalid API version ${options.apiLevel}. API version 17 or higher is required.`
      );
    }
    
    // 最大 API 验证
    if (sdkMaxApi !== undefined) {
      // 有 IDE：范围 17 ~ SDK maxApi
      if (parsed > sdkMaxApi) {
        throw new Error(
          `Invalid API version ${options.apiLevel}. Your SDK supports API version 17-${sdkMaxApi}`
        );
      }
    } else {
      // 无 IDE：范围 17-23
      if (parsed > noIdeMaxApi) {
        throw new Error(
          `Invalid API version ${options.apiLevel}. Without DevEco Studio, supported range is API version 17-${noIdeMaxApi}`
        );
      }
    }
    
    return parsed;
  }

  // 不指定 API 时的默认值
  if (sdkMaxApi !== undefined) {
    // 有 IDE：使用 SDK 的 apiVersion
    return sdkMaxApi;
  }
  
  // 无 IDE：默认 API 23
  return 23;
}

async function tryGetToolProvider(): Promise<ToolProvider | undefined> {
  try {
    return await ToolProvider.new();
  } catch (error) {
    const e = error as Error;
    console.error(yellow(`DevEco Studio not found: ${e.message}`));
    console.log(yellow('Use placeholder API level instead.'));
    return undefined;
  }
}

const createCommand = new Command('create')
  .description('Scaffold a new HarmonyOS application project')
  .option(
    '--project-path <path>',
    'Project directory path (default: ./<app-name>)'
  )
  .option('--app-name <name>', 'Application name')
  .option(
    '--bundle-name <bundle>',
    'Bundle name (auto-derived as com.example.<app-name> if omitted)'
  )
  .option(
    '--api-level <level>',
    'API level (auto-detected from SDK if omitted; minimum: 17)'
  )
  .action(async (options: CreateOptions) => {
    try {
      if (!options.appName) {
        console.error(red('Error: --app-name is required'));
        process.exit(1);
      }

      const appName = options.appName;
      validateAppName(appName);

      const bundleName = options.bundleName || deriveBundleName(appName);
      validateBundleName(bundleName);

      if (options.projectPath) {
        validateProjectPath(options.projectPath);
      }

      const projectPath = resolveProjectPath(appName, options.projectPath);
      validateProjectPath(projectPath);

      console.log(cyan('Initializing project...'));
      console.log(`Project path: ${projectPath}`);
      console.log(`App name: ${appName}`);
      console.log(`Bundle name: ${bundleName}`);

      const toolProvider = await tryGetToolProvider();
      const apiLevel = resolveApiLevel(options, toolProvider);
      console.log(`API level: ${apiLevel}`);

      const devecoStudioPath = toolProvider?.devecoStudioPath;

      const result: CreateProjectResult = createProject(
        projectPath,
        appName,
        bundleName,
        apiLevel,
        devecoStudioPath
      );

      console.log('\n' + green('Project created successfully.'));
      console.log(`Project root: ${result.projectRoot}`);
      console.log(`App name: ${result.appName}`);
      console.log(`Bundle name: ${result.bundleName}`);
      console.log(`API level: ${result.apiLevel}`);
      console.log(green('Template integrity check passed.'));
    } catch (error) {
      const e = error as Error;
      console.error(red('\nFailed to create project.'));
      console.error(red(e.message));
      process.exit(1);
    }
  });

export default createCommand;
