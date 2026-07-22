/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';
import { ToolProvider } from '../../toolchain/index.js';
import { debugLog } from '../../utils/logger.js';
import type { CheckResult } from './types.js';

export class ToolchainChecker {
  constructor(private toolProvider: ToolProvider) {}

  /**
   * 场景 7：检查 Java 运行时是否可用（JBR 或独立 JDK）。
   */
  checkJava(fail: (msg: string) => CheckResult): CheckResult {
    const validPlatforms = ['win32', 'darwin', 'linux'];
    if (!validPlatforms.includes(process.platform)) {
      return fail('Java environment not found (Windows/macOS/Linux only).');
    }
    try {
      this.toolProvider.assertJava();
      return { passed: true, message: '' };
    } catch (e) {
      debugLog(`[EnvCheck] Java check failed: ${(e as Error).message}`);
      return fail('Java runtime is required to run hvigor.Set JAVA_HOME or add Java to PATH.');
    }
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
