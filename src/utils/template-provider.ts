/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs-extra';
import path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';

const API_CONFIGS: Record<
  number,
  { sdkVersion: string; modelVersion: string }
> = {
  17: { sdkVersion: '5.0.5(17)', modelVersion: '5.0.5' },
  18: { sdkVersion: '5.1.0(18)', modelVersion: '5.1.0' },
  19: { sdkVersion: '5.1.1(19)', modelVersion: '5.1.1' },
  20: { sdkVersion: '6.0.0(20)', modelVersion: '6.0.0' },
  21: { sdkVersion: '6.0.1(21)', modelVersion: '6.0.1' },
  22: { sdkVersion: '6.0.2(22)', modelVersion: '6.0.2' },
  23: { sdkVersion: '6.1.0(23)', modelVersion: '6.1.0' },
  24: { sdkVersion: '6.1.1(24)', modelVersion: '6.1.1' },
};

const REQUIRED_FILES = [
  'build-profile.json5',
  'AppScope/resources/base/media/layered_image.json',
  'entry/src/main/resources/base/media/layered_image.json',
];

function getTemplateDir(): string {
  const currentFileUrl = import.meta.url;
  const currentFilePath = fileURLToPath(currentFileUrl);

  if (currentFilePath.includes('dist')) {
    const distDir = path.dirname(currentFilePath);
    const projectRoot = path.dirname(distDir);
    return path.join(projectRoot, 'templates', 'application');
  }

  const utilsDir = path.dirname(currentFilePath);
  const srcDir = path.dirname(utilsDir);
  const projectRoot = path.dirname(srcDir);
  return path.join(projectRoot, 'templates', 'application');
}

function copyDirectoryContents(sourceDir: string, targetDir: string): void {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryContents(sourcePath, targetPath);
      continue;
    }

    if (fs.existsSync(targetPath)) {
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
}

function replaceInFile(filePath: string, pairs: Array<[string, string]>): void {
  const original = fs.readFileSync(filePath, 'utf-8');
  let next = original;

  for (const [from, to] of pairs) {
    next = next.replaceAll(from, to);
  }

  if (next !== original) {
    fs.writeFileSync(filePath, next, 'utf-8');
  }
}

function updateApiLevel(targetRoot: string, apiLevel: number): void {
  if (apiLevel === 22) {
    return;
  }

  const config = API_CONFIGS[apiLevel];
  if (!config) {
    return;
  }

  replaceInFile(path.join(targetRoot, 'build-profile.json5'), [
    ['6.0.2(22)', config.sdkVersion],
  ]);

  replaceInFile(path.join(targetRoot, 'hvigor', 'hvigor-config.json5'), [
    ['6.0.2', config.modelVersion],
  ]);

  replaceInFile(path.join(targetRoot, 'oh-package.json5'), [
    ['6.0.2', config.modelVersion],
  ]);
}

function verifyFiles(targetRoot: string): boolean {
  const missingFiles = REQUIRED_FILES.filter(
    (relativePath) => !fs.existsSync(path.join(targetRoot, relativePath))
  );

  return missingFiles.length === 0;
}

function generateMinimalPng(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
    0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xff, 0xff, 0xff,
    0x00, 0x05, 0xfe, 0x02, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
}

function getDevEcoTemplatePath(devecoStudioPath: string): string {
  const platform = os.platform();

  // Mac 平台：DevEco-Studio.app/Contents/plugins
  // Windows 平台：DevEco Studio/plugins
  if (platform === 'darwin') {
    return path.join(
      devecoStudioPath,
      'Contents',
      'plugins',
      'codegenie-plugin',
      'previewProjectTemplate'
    );
  } else {
    return path.join(
      devecoStudioPath,
      'plugins',
      'codegenie-plugin',
      'previewProjectTemplate'
    );
  }
}

function copyFromDevEcoStudio(
  targetRoot: string,
  devecoStudioPath: string
): boolean {
  const templateMediaPath = getDevEcoTemplatePath(devecoStudioPath);

  if (!fs.existsSync(templateMediaPath)) {
    return false;
  }

  const imageMappings = [
    [
      'AppScope/resources/base/media/background.png',
      'AppScope/resources/base/media/background.png',
    ],
    [
      'AppScope/resources/base/media/foreground.png',
      'AppScope/resources/base/media/foreground.png',
    ],
    [
      'entry/src/main/resources/base/media/background.png',
      'entry/src/main/resources/base/media/background.png',
    ],
    [
      'entry/src/main/resources/base/media/foreground.png',
      'entry/src/main/resources/base/media/foreground.png',
    ],
    [
      'entry/src/main/resources/base/media/startIcon.png',
      'entry/src/main/resources/base/media/startIcon.png',
    ],
  ];

  for (const [relativeSrc, relativeDest] of imageMappings) {
    const srcPath = path.join(templateMediaPath, relativeSrc);
    const destPath = path.join(targetRoot, relativeDest);

    if (fs.existsSync(srcPath)) {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }

  return true;
}

function generateFallbackIcons(targetRoot: string): void {
  const pngBuffer = generateMinimalPng();

  const imagePaths = [
    'AppScope/resources/base/media/background.png',
    'AppScope/resources/base/media/foreground.png',
    'entry/src/main/resources/base/media/background.png',
    'entry/src/main/resources/base/media/foreground.png',
    'entry/src/main/resources/base/media/startIcon.png',
  ];

  for (const imagePath of imagePaths) {
    const fullPath = path.join(targetRoot, imagePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, pngBuffer);
  }
}

function createPlaceholderImages(
  targetRoot: string,
  devecoStudioPath?: string
): void {
  if (devecoStudioPath) {
    if (copyFromDevEcoStudio(targetRoot, devecoStudioPath)) {
      return;
    }
  }

  generateFallbackIcons(targetRoot);
}

export interface CreateProjectResult {
  projectRoot: string;
  appName: string;
  bundleName: string;
  apiLevel: number;
  verified: boolean;
}

export function createProject(
  projectPath: string,
  appName: string,
  bundleName: string,
  apiLevel: number,
  devecoStudioPath?: string
): CreateProjectResult {
  const templateDir = getTemplateDir();

  if (!fs.existsSync(templateDir)) {
    throw new Error(`Template directory not found: ${templateDir}`);
  }

  fs.mkdirSync(projectPath, { recursive: true });

  copyDirectoryContents(templateDir, projectPath);

  createPlaceholderImages(projectPath, devecoStudioPath);

  replaceInFile(
    path.join(
      projectPath,
      'AppScope',
      'resources',
      'base',
      'element',
      'string.json'
    ),
    [['MyApplication', appName]]
  );

  replaceInFile(path.join(projectPath, 'AppScope', 'app.json5'), [
    ['com.example.myapplication', bundleName],
  ]);

  updateApiLevel(projectPath, apiLevel);

  const verified = verifyFiles(projectPath);

  if (!verified) {
    throw new Error('Template integrity check failed.');
  }

  return {
    projectRoot: projectPath,
    appName,
    bundleName,
    apiLevel,
    verified,
  };
}
