/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * init.ts
 *
 * BuildConfigManager：普通构建时生成 build/config/buildConfig.json
 * （含 compileConfig + patchConfig），供 apply 的 hvigor assembleDevHqf 复用。
 */

import fs from 'fs';
import * as path from 'path';
import { ToolProvider } from '../toolchain/index.js';
import { debugLog } from '../utils/logger.js';
import { resolveModuleSrcPath } from './module-path.js';

export class BuildConfigManager {
  public static generate(
    projectRoot: string,
    moduleName: string,
    productName: string,
    toolProvider: ToolProvider
  ): void {
    const srcPath = resolveModuleSrcPath(projectRoot, moduleName);
    const moduleDir = path.join(projectRoot, srcPath);
    const configDir = path.join(moduleDir, 'build', 'config');
    const config = BuildConfigManager.buildConfig(
      projectRoot, moduleDir, productName, toolProvider
    );
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'buildConfig.json'),
      JSON.stringify(config, null, 2),
      'utf-8'
    );
    debugLog(`[BuildConfigManager] buildConfig.json written to ${configDir}`);
    // es2abc 不自动创建 ets 输出目录，需预建
    const etsOutDir = path.join(moduleDir, 'build', productName, 'intermediates', 'loader_out', productName, 'ets');
    fs.mkdirSync(etsOutDir, { recursive: true });
  }

  private static buildConfig(
    projectRoot: string,
    moduleDir: string,
    productName: string,
    toolProvider: ToolProvider
  ): { compileConfig: Record<string, string>; patchConfig: Record<string, string> } {
    const nodeDir = path.dirname(toolProvider.nodePath) + path.sep;
    const buildDefault = path.join(moduleDir, 'build', productName);
    const intermediates = path.join(buildDefault, 'intermediates');
    const loaderOut = path.join(intermediates, 'loader_out', productName);
    const resDir = path.join(intermediates, 'res', productName);

    return {
      compileConfig: {
        deviceType: 'default',
        buildMode: 'debug',
        compilerType: 'ark',
        note: 'false',
        logLevel: '3',
        hapMode: 'false',
        img2bin: 'true',
        Path: nodeDir,
        projectProfilePath: path.join(projectRoot, 'build-profile.json5'),
        localPropertiesPath: path.join(projectRoot, 'local.properties'),
        appResource: path.join(resDir, 'ResourceTable.txt'),
        cachePath: path.join(buildDefault, 'cache', productName, `${productName}@CompileArkTS`, 'esmodule', 'debug'),
        aceBuildJson: path.join(intermediates, 'loader', productName, 'loader.json'),
        aceModuleJsonPath: path.join(resDir, 'module.json'),
        aceSoPath: path.join(loaderOut, 'nativeDependencies.txt'),
        aceModuleRoot: path.join(moduleDir, 'src', 'main', 'ets'),
        aceModuleBuild: path.join(loaderOut, 'ets'),
        aceProfilePath: path.join(resDir, 'resources', 'base', 'profile'),
        aceSuperVisualPath: path.join(moduleDir, 'src', 'main', 'supervisual'),
        watchMode: 'true',
      },
      // 普通构建不启用 hotfix symbol map;热重载用独立的 HotReloadBuildConfigManager
      patchConfig: {
        enableMap: 'false',
        mode: 'hotReload',
        oldMapFilePath: path.join(loaderOut, 'ets'),
        changedFileList: path.join(intermediates, 'patch', productName, 'changedFileList.json'),
        patchAbcPath: path.join(intermediates, 'patch', productName, 'ets'),
        removeChangedFileListInSdk: 'true',
      },
    };
  }
}
