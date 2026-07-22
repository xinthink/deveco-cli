/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { ToolProvider } from '../toolchain/index.js';
import { red } from 'colorette';
import { debugLog } from '../utils/logger.js';
import { ProjectChecker } from './env-check/project-checker.js';
import { ToolchainChecker } from './env-check/toolchain-checker.js';
import { AuthChecker } from './env-check/auth-checker.js';
import { DeviceChecker } from './env-check/device-checker.js';
import {
  processExitHandler,
  type ExitHandler,
} from './env-check/exit-handler.js';
import type { CheckResult, CheckContext } from './env-check/types.js';

export type { CheckResult, CheckContext } from './env-check/types.js';

/**
 * 环境预检器：按优先级顺序运行场景 1→12 的检查。
 * 任一检查失败即终止，并输出单行错误信息。
 */
export class EnvChecker {
  private projectChecker = new ProjectChecker();
  private toolchainChecker: ToolchainChecker | null = null;
  private authChecker = new AuthChecker();
  private deviceChecker: DeviceChecker | null = null;

  constructor(private exitHandler: ExitHandler = processExitHandler) {}

  /**
   * 运行所有环境预检检查。
   * 所有检查通过返回 true，任一失败则终止进程。
   */
  public async preflight(ctx: CheckContext): Promise<boolean> {
    const failFast = (r: CheckResult): boolean => {
      if (!r.passed) { this.fail(r); return false; }
      return true;
    };
    const bf = (m: string) => this.blockingFail(m);

    // ── 顺序 fail-fast 链：场景 1（登录）→ 场景 2（团队信息）→ 场景 3（实名认证）──
    // 认证检查不依赖工程目录或工具链，最先执行
    const authChain: Array<() => Promise<CheckResult>> = [
      () => this.authChecker.checkLogin(bf),
      () => this.authChecker.checkTeamInfo(bf),
      () => this.authChecker.checkRealname(bf),
    ];
    for (const c of authChain) { if (!failFast(await c())) { return false; } }

    // 初始化 ToolProvider（设备检查需要）
    try {
      const tp = await ToolProvider.new();
      this.toolchainChecker = new ToolchainChecker(tp);
      this.deviceChecker = new DeviceChecker(tp);
    } catch (e) {
      console.error('Auto-sign failed: unable to initialize toolchain');
      debugLog(`[EnvCheck] ToolProvider.new() failed: ${(e as Error).message}`);
      this.exitHandler.exit(1);
    }

    // 场景 4：设备检查（需要 ToolProvider）
    if (!failFast(await this.deviceChecker!.checkDevice(bf))) {
      return false;
    }

    // 场景 10：项目目录检查（不依赖 ToolProvider）
    if (!failFast(this.projectChecker.checkProjectDir((m) => this.blockingFail(m)))) {
      return false;
    }

    // 场景 13：元服务工程检查（不依赖 ToolProvider）
    if (!failFast(this.projectChecker.checkAtomicService())) {
      return false;
    }

    // 同步检查：场景 5、6（项目），7、8、9（工具链）
    const syncChecks: Array<() => CheckResult> = [
      () => this.projectChecker.checkProduct(ctx.productName, bf),
      () => this.projectChecker.checkBundleName(ctx.productName, bf),
      () => this.toolchainChecker!.checkJava(bf),
      () => this.toolchainChecker!.checkHapSignTools(bf),
    ];
    for (const c of syncChecks) { if (!failFast(c())) { return false; } }

    // 场景 11、12：辅助检查
    if (!failFast(await this.authChecker.checkTeamId(ctx.teamId))) { return false; }
    await this.authChecker.checkRegion(bf);

    return true;
  }

  // ─── 工厂方法 ──────────────────────────────────────────

  private blockingFail(message: string): CheckResult {
    return { passed: false, message };
  }

  // ─── 输出方法 ───────────────────────────────────────────

  /** 输出错误信息并终止。 */
  private fail(result: CheckResult): void {
    console.error(red(`Error:${result.message}`));
    debugLog(`[EnvCheck] FAIL: ${result.message}`);
    this.exitHandler.exit(1);
  }
}
