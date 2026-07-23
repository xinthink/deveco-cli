/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { loginService, getTeamList } from '../../auth/index.js';
import { debugLog } from '../../utils/logger.js';
import type { UserInfo } from '../../auth/types/auth-types.js';
import type { CheckResult } from './types.js';

export class AuthChecker {
  private _userInfo: UserInfo | null = null;

  private async ensureUserInfo(): Promise<UserInfo | null> {
    if (!this._userInfo) {
      try {
        this._userInfo = await loginService.getUserInfo();
      } catch (e) {
        debugLog(`[EnvCheck] Failed to load user info: ${(e as Error).message}`);
        return null;
      }
    }
    return this._userInfo;
  }

  /**
   * 场景 1：检查用户是否已通过有效的 JWT 令牌登录。
   */
  async checkLogin(
    fail: (msg: string) => CheckResult
  ): Promise<CheckResult> {
    try {
      const loggedIn = await loginService.isLoggedIn();
      if (!loggedIn) {
        return fail('Failed to automatically generate signatures.Run devecocli auth login to sign in.');
      }
      await this.ensureUserInfo();
      return { passed: true, message: '' };
    } catch (e) {
      debugLog(`[EnvCheck] Login check failed: ${(e as Error).message}`);
      return fail('Failed to automatically generate signatures.Run devecocli auth login to sign in.');
    }
  }

  /**
   * 场景 2：检查团队信息是否可用。
   */
  async checkTeamInfo(fail: (msg: string) => CheckResult): Promise<CheckResult> {
    const userInfo = await this.ensureUserInfo();
    if (!userInfo) {
      return fail('Failed to obtain user team information.Check the network connection, HTTP proxy, and other configurations.');
    }
    try {
      const teamListResult = await getTeamList();
      if (teamListResult.teamList.length > 0) {
        return { passed: true, message: '' };
      }
    } catch (e) {
      debugLog(`[EnvCheck] Team API error: ${(e as Error).message}`);
      return fail('Failed to obtain user team information.Check the network connection, HTTP proxy, and other configurations.');
    }
    debugLog(`[EnvCheck] No teams found for current user`);
    return fail('Failed to obtain user team information.Check the network connection, HTTP proxy, and other configurations.');
  }

  /**
   * 场景 3：检查实名认证状态。
   * 如果 API 未返回 realName 字段，则降级跳过检查。
   */
  async checkRealname(
    fail: (msg: string) => CheckResult
  ): Promise<CheckResult> {
    const userInfo = await this.ensureUserInfo();
    if (!userInfo) {
      return fail('User session expired or token invalid. Please login again.');
    }
    if (userInfo.isRealName === false) {
      return fail('Users without real-name verification are not supported.Complete real-name verification in AppGallery Connect.');
    }
    if (userInfo.isRealName !== true) {
      debugLog(`[EnvCheck] Scenario 3 Real-name check: AGC API did not return realName field`);
      return fail('Users without real-name verification are not supported.Complete real-name verification in AppGallery Connect.');
    }
    return { passed: true, message: '' };
  }

  /**
   * 场景 11：检查 team-id 配置。
   * 如果传入了 teamId，则校验其是否在可用团队列表中；
   * 否则使用当前用户的默认团队 ID 作为兜底。
   */
  async checkTeamId(teamId?: string): Promise<CheckResult> {
    const userInfo = await this.ensureUserInfo();
    if (!userInfo) {
      return { passed: true, message: '' };
    }

    let resolvedTeamId = teamId ?? '';

    try {
      const teamListResult = await getTeamList();

      // 解析最终的 teamId：优先使用传入值，否则取团队列表第一个，最后回退到 userId
      resolvedTeamId = teamId ??
        (teamListResult.teamList.length > 0 ? teamListResult.teamList[0].id : userInfo.userId) ??
        '';

      const teamExists = teamListResult.teamList.some(t => t.id === resolvedTeamId);

      if (!teamExists) {
        const msg = `team-id for ${resolvedTeamId} not found.Run devecocli auth team list to view the team to which the logged-in user belongs.`;
        debugLog(`[EnvCheck] ${msg}`);
        return { passed: false, message: msg };
      }
      return { passed: true, message: '' };
    } catch (e) {
      debugLog(`[EnvCheck] Team ID check failed: ${(e as Error).message}`);
      return { passed: false, message: `team-id for ${resolvedTeamId} not found.Run devecocli auth team list to view the team to which the logged-in user belongs.` };
    }
  }

  /**
   * 场景 12：检查账号是否为中国区域。
   * 如果 API 未返回 countryCode 字段，则降级跳过检查。
   */
  async checkRegion(
    fail: (msg: string) => CheckResult
  ): Promise<CheckResult> {
    const userInfo = await this.ensureUserInfo();
    if (!userInfo) {
      return fail('User session expired or token invalid. Please login again.');
    }
    if (!userInfo.countryCode) {
      debugLog(`[EnvCheck] Scenario 12 Region check: AGC API did not return nationalCode field`);
      return fail('This feature is only available for accounts registered in Chinese mainland.');
    }
    if (userInfo.countryCode !== 'CN') {
      return fail('This feature is only available for accounts registered in Chinese mainland.');
    }
    return { passed: true, message: '' };
  }
}
