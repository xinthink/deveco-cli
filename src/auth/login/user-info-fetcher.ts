/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { httpClient } from '../../utils/http-client';
import type { UserInfo, TokenCheckResponse, JwtPayload } from '../types/auth-types';
import { parseJwtPayload, isValidJwtFormat } from '../utils/jwt';
import {
  getLanguageByCountryCode,
  getCountryCodeBySiteId,
} from '../utils/region';
import { AppConfig } from '../auth-config';

/**
 * 用户信息获取服务
 * 负责从 JWT Token 获取用户信息和换取 JWT Token
 */
export class UserInfoFetcher {
  /**
   * 获取 JWT Token
   * 使用临时 Token 和站点 ID 从服务器换取 JWT Token
   * @param tempToken 临时 Token
   * @param siteId 站点 ID
   * @param getRegionalizedBaseUrl 获取区域化基础 URL 的函数
   * @param tempTokenCheckUrl 临时 Token 检查 URL 路径
   * @param appId 应用 ID
   * @returns JWT Token 字符串
   */
  async getJwtToken(
    tempToken: string,
    siteId: string,
    getRegionalizedBaseUrl: () => string,
    tempTokenCheckUrl: string,
    appId: string
  ): Promise<string> {
    const actualTempToken = tempToken.split('&')[0];

    const countryCode = getCountryCodeBySiteId(siteId);
    const regionalizedBaseUrl = getRegionalizedBaseUrl();

    const params = {
      tempToken: actualTempToken,
      site: countryCode,
      version: AppConfig.API_VERSION,
      appid: appId,
    };

    const url = `${regionalizedBaseUrl}/${tempTokenCheckUrl}`;
    const response = await httpClient.get(url, { params });

    if (response.statusCode !== 200) {
      throw new Error(`Failed to get jwtToken: status=${response.statusCode}`);
    }

    const jwtToken = response.data.trim();

    if (!isValidJwtFormat(jwtToken)) {
      throw new Error(`Invalid jwtToken format`);
    }

    return jwtToken;
  }

  /**
   * 从 JWT Token 获取用户信息
   * @param jwtToken JWT Token 字符串
   * @param checkJwtToken 检查 JWT Token 的函数
   * @returns 用户信息对象
   */
  async getUserInfoFromJwt(
    jwtToken: string,
    checkJwtToken: (jwtToken: string) => Promise<TokenCheckResponse>
  ): Promise<UserInfo> {
    const tokenInfo = await checkJwtToken(jwtToken);

    if (!tokenInfo.status || !tokenInfo.userInfo) {
      throw new Error('Invalid jwtToken');
    }

    const payload = parseJwtPayload<JwtPayload>(jwtToken);
    if (!payload) {
      throw new Error('Invalid jwtToken: failed to parse payload');
    }

    const userInfo: UserInfo = {
      userId: payload.userId,
      userName: payload.userName,
      accessToken: tokenInfo.userInfo.accessToken,
      refreshToken: tokenInfo.userInfo.refreshToken ?? '',
      jwtToken: jwtToken,
      countryCode: tokenInfo.userInfo.nationalCode,
      language: getLanguageByCountryCode(tokenInfo.userInfo.nationalCode),
      isRealName: tokenInfo.userInfo.realName === 'true',
    };

    return userInfo;
  }
}

// 单例导出
export const userInfoFetcher = new UserInfoFetcher();
