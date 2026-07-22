/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import axios from 'axios';
import { tokenStorage } from '../utils/token-storage.js';
import { getRegionalizedBaseUrl } from '../utils/region.js';
import { DEFAULT_LOGIN_CONFIG } from '../auth-config.js';
import {
  AGC_SUCCESS_CODE,
  type Team,
  type TeamListResult,
  type LoginConfig,
  type AgcTeamListResponse,
} from '../types/auth-types.js';
import { debugLog } from '../../utils/logger.js';

const MISSING_TOKEN_HINT = 'No JWT in local storage. Run `devecocli auth login` first.';

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
    const jwtToken = await tokenStorage.loadJwtToken();
    if (!jwtToken) {
      throw new Error(MISSING_TOKEN_HINT);
    }

    const { accessToken, userId } = await this.fetchAccessToken(jwtToken);
    if (!accessToken) {
      throw new Error('Session expired. Run `devecocli auth login` again.');
    }

    const body = await this.fetchTeamList(accessToken, userId ?? '');
    const teamList = parseTeamListResponse(body);
    return {
      userId: userId ?? '',
      teamList,
    };
  }

  private async fetchTeamList(
    accessToken: string,
    userId: string
  ): Promise<unknown> {
    const url = this.config.agcTeamListUrl;
    debugLog(`Executing: GET ${url}`);

    let response;
    try {
      response = await axios.request({
        method: 'GET',
        url,
        headers: {
          oauth2Token: accessToken,
          uid: userId,
          source: 'cli',
          lang: 'zh_CN',
        },
        timeout: 15000,
        transformResponse: [(data) => data],
        proxy: false,
        validateStatus: () => true,
      });
    } catch (err) {
      throw new Error(
        `Network error while listing teams: ${(err as Error).message}`,
        { cause: err }
      );
    }

    if (response.status === 401) {
      throw new Error('AGC rejected the AGC token. Run `devecocli auth login` again.');
    }
    if (response.status !== 200) {
      throw new Error(`Failed to list teams: HTTP ${response.status}`);
    }

    return typeof response.data === 'string'
      ? JSON.parse(response.data)
      : response.data;
  }

  private async fetchAccessToken(
    jwtToken: string
  ): Promise<{ accessToken?: string; userId?: string }> {
    const baseUrl = this.getRegionalizedBaseUrl();
    const url = `${baseUrl}/${this.config.jwtTokenCheckUrl}`;
    debugLog(`Executing: GET ${url} (accessToken refresh)`);

    let response;
    try {
      response = await axios.request({
        method: 'GET',
        url,
        headers: { refresh: 'true', jwtToken: jwtToken },
        timeout: 15000,
        transformResponse: [(data) => data],
        proxy: false,
        validateStatus: () => true,
      });
    } catch (err) {
      throw new Error(
        `Network error while refreshing accessToken: ${(err as Error).message}`,
        { cause: err }
      );
    }

    if (response.status !== 200) {
      throw new Error(
        `Failed to refresh accessToken: HTTP ${response.status}. Run \`devecocli auth login\` again.`
      );
    }

    const body =
      typeof response.data === 'string'
        ? JSON.parse(response.data)
        : response.data;
    const parsed = body as AgcJwtCheckResponse;
    if (!parsed.status) {
      throw new Error('JWT is invalid. Run `devecocli auth login` again.');
    }
    return {
      accessToken: parsed.userInfo?.accessToken,
      userId: parsed.userInfo?.userId,
    };
  }

  private getRegionalizedBaseUrl(): string {
    return getRegionalizedBaseUrl(
      this.config.countryCode ?? '',
      this.config.baseUrl
    );
  }
}

export const teamListAdapter = new TeamListAdapter();

export async function getTeamList(): Promise<TeamListResult> {
  return teamListAdapter.listTeams();
}
