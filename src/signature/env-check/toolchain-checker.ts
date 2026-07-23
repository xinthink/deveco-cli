/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { ToolProvider } from '../../toolchain/index.js';
import { debugLog } from '../../utils/logger.js';
import { EnvCheckMessages } from '../../config/signature.js';
import type { CheckResult } from './types.js';

/**
 * 在指定目录中查找 java 可执行文件。
 */
function javaIn(directory: string): string | undefined {
  const names = os.platform() === 'win32' ? ['java.exe', 'java.cmd'] : ['java'];
  return names.map((name) => path.join(directory, name)).find(fs.existsSync);
}

export class ToolchainChecker {
  constructor(private toolProvider: ToolProvider) {}

  /**
   * 场景 7：检查 CLT 模式 Java 运行环境。
   * 优先检查 JAVA_HOME 环境变量，再回退到 PATH。
   */
  checkJava(fail: (msg: string) => CheckResult): CheckResult {
    const validPlatforms = ['win32', 'darwin', 'linux'];
    if (!validPlatforms.includes(process.platform)) {
      return fail(EnvCheckMessages.JAVA_PLATFORM_UNSUPPORTED);
    }

    // 1) 检查 JAVA_HOME
    const home = process.env.JAVA_HOME?.trim();
    if (home) {
      const found = javaIn(path.join(home, 'bin')) ?? javaIn(home);
      if (found) {
        return { passed: true, message: '' };
      }
    }

    // 2) 检查 PATH
    const pathEnv = process.env.Path ?? process.env.PATH ?? '';
    const foundInPath = pathEnv
      .split(path.delimiter)
      .map((entry) => javaIn(entry.trim()))
      .find(Boolean);
    if (foundInPath) {
      return { passed: true, message: '' };
    }

    debugLog(`[EnvCheck] Java not found in JAVA_HOME or PATH`);
    return fail(EnvCheckMessages.JAVA_REQUIRED);
  }

  /**
   * 场景 8：验证 hap-sign-tool.jar 是否存在于 SDK toolchains 目录中。
   */
  checkHapSignTools(fail: (msg: string) => CheckResult): CheckResult {
    const sdkPath = this.toolProvider.sdkPath;
    const hapSignToolPath = path.join(
      sdkPath,
      'default',
      'openharmony',
      'toolchains',
      'lib',
      'hap-sign-tool.jar'
    );

    if (!fs.existsSync(hapSignToolPath)) {
      const relativePath = path.join('sdk', 'default', 'openharmony', 'toolchains', 'lib', 'hap_sign_tools.jar');
      return fail(`hap_sign_tools.jar not found.Check whether ${relativePath} exists.`);
    }
    return { passed: true, message: '' };
  }
}
