/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { httpClient } from '../../utils/http-client.js';
import { isDevecoCodeAuth, DefinedError } from '../index.js';
import { DEFAULT_LOGIN_CONFIG } from '../auth-config.js';
import { LanguageCode } from '../utils/region.js';
import { tokenChecker } from '../utils/token-checker.js';
import { ApiEndpoints } from '../auth-config.js';
import {
  AGC_SUCCESS_CODE,
  type Team,
  type TeamListResult,
  type LoginConfig,
  type AgcTeamListResponse,
} from '../types/auth-types.js';

function getLoginHint(): string {
  return isDevecoCodeAuth()
    ? 'Not logged in. Please login via DevEco Code first.'
    : 'Please run `devecocli auth login` first.';
}

export function parseTeamListResponse(raw: unknown): Team[] {
  if (raw == null || typeof raw !== 'object') {
    return [];
  }
  const payload = raw as AgcTeamListResponse;
  if (payload.ret && payload.ret.code !== AGC_SUCCESS_CODE) {
    throw new Error(
      `team list request failed: code=${payload.ret.code}${
        payload.ret.msg ? `, msg=${payload.ret.msg}` : ''
      }`
    );
  }
  if (!Array.isArray(payload.teams)) {
    return [];
  }
  return payload.teams
    .filter((team): team is Team => typeof team === 'object' && team !== null)
    .map((team) => ({
      id: String(team.id ?? ''),
      upSiteId: Number(team.upSiteId ?? 0),
      name: String(team.name ?? ''),
      countryCode: String(team.countryCode ?? ''),
      siteId: Number(team.siteId ?? 0),
      userType: Number(team.userType ?? 0),
      lastLoginTime: String(team.lastLoginTime ?? ''),
      isMirror: team.isMirror === true,
    }))
    .filter((team) => team.id.length > 0);
}

export class TeamListAdapter {
  private config: LoginConfig;

  constructor(config?: Partial<LoginConfig>) {
    this.config = { ...DEFAULT_LOGIN_CONFIG, ...config };
  }

  public updateConfig(config: Partial<LoginConfig>): void {
    this.config = { ...this.config, ...config };
  }

  public async listTeams(): Promise<TeamListResult> {
    const userInfo = await tokenChecker.fetchUserInfo(ApiEndpoints.CN_LOGIN_URL, true);
    if (!userInfo) {
      throw new DefinedError(getLoginHint());
    }

    const body = await this.fetchTeamList(userInfo.accessToken, userInfo.userId);
    const teamList = parseTeamListResponse(body);
    return { userId: userInfo.userId, teamList };
  }

  /**
   * 从 AGC 获取团队列表
   * @param accessToken 访问令牌
   * @param userId 用户 ID
   * @returns 团队列表原始数据
   */
  private async fetchTeamList(
    accessToken: string,
    userId: string
  ): Promise<unknown> {
    const url = this.config.agcTeamListUrl;

    let response;
    try {
      response = await httpClient.get(url, {
        headers: {
          oauth2Token: accessToken,
          uid: userId,
          source: 'cli',
          lang: LanguageCode.CHINA,
        },
        timeout: 15000,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('401')) {
        throw new DefinedError('Token expired. Run `devecocli auth login` again.');
      }
      throw new Error(
        `Network error while listing teams: ${msg}`,
        { cause: err }
      );
    }

    if (response.statusCode !== 200) {
      throw new Error(`Failed to list teams: HTTP ${response.statusCode}`);
    }

    return typeof response.data === 'string'
      ? JSON.parse(response.data)
      : response.data;
  }
}

export const teamListAdapter = new TeamListAdapter();

/**
 * 获取团队列表
 * @returns 团队列表结果
 */
export async function getTeamList(): Promise<TeamListResult> {
  return teamListAdapter.listTeams();
}
