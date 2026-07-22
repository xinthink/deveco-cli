/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { httpClient } from '../../utils/http-client';
import { tokenStorage } from './token-storage';
import type { TokenCheckResponse } from '../types/auth-types';

/**
 * Token 检查服务
 * 负责 JWT Token 的有效性检查和刷新
 */
export class TokenChecker {
  /**
   * 检查 JWT Token 有效性
   * @param jwtToken JWT Token 字符串
   * @param getRegionalizedBaseUrl 获取区域化基础 URL 的函数
   * @param jwtTokenCheckUrl JWT Token 检查 URL 路径
   * @returns Token 检查响应，包含用户信息和状态
   */
  async checkJwtToken(
    jwtToken: string,
    getRegionalizedBaseUrl: () => string,
    jwtTokenCheckUrl: string
  ): Promise<TokenCheckResponse> {
    const headers = {
      refresh: 'false',
      jwtToken: jwtToken,
    };

    const regionalizedBaseUrl = getRegionalizedBaseUrl();
    const url = `${regionalizedBaseUrl}/${jwtTokenCheckUrl}`;
    const response = await httpClient.get(url, { headers });

    if (response.statusCode !== 200) {
      throw new Error(`Failed to check jwtToken: ${response.statusCode}`);
    }

    const result = httpClient.parseJson<TokenCheckResponse>(response);
    return result;
  }

  /**
   * 刷新 accessToken
   * 从磁盘加载 JWT Token 并刷新
   * @param getRegionalizedBaseUrl 获取区域化基础 URL 的函数
   * @param jwtTokenCheckUrl JWT Token 检查 URL 路径
   * @returns 刷新后的 Token 对，如果失败返回 null
   */
  async refreshToken(
    getRegionalizedBaseUrl: () => string,
    jwtTokenCheckUrl: string
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    const jwtToken = await tokenStorage.loadJwtToken();
    if (!jwtToken) {
      return null;
    }
    return this.refreshTokenWithToken(
      jwtToken,
      getRegionalizedBaseUrl,
      jwtTokenCheckUrl
    );
  }

  /**
   * 使用指定的 JWT Token 刷新 accessToken
   * @param jwtToken JWT Token 字符串
   * @param getRegionalizedBaseUrl 获取区域化基础 URL 的函数
   * @param jwtTokenCheckUrl JWT Token 检查 URL 路径
   * @returns 刷新后的 Token 对，如果失败返回 null
   */
  async refreshTokenWithToken(
    jwtToken: string,
    getRegionalizedBaseUrl: () => string,
    jwtTokenCheckUrl: string
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    try {
      const headers: Record<string, string> = {
        refresh: 'true',
        jwtToken: jwtToken,
      };

      const regionalizedBaseUrl = getRegionalizedBaseUrl();
      const url = `${regionalizedBaseUrl}/${jwtTokenCheckUrl}`;
      const response = await httpClient.get(url, { headers });

      if (response.statusCode !== 200) {
        return null;
      }

      const result = httpClient.parseJson<TokenCheckResponse>(response);
      if (!result.status || !result.userInfo) {
        return null;
      }

      return {
        accessToken: result.userInfo.accessToken,
        refreshToken: result.userInfo.refreshToken ?? '',
      };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      console.error(
        `Failed to refresh token: ${e.code ?? ''} ${e.message ?? ''}`
      );
      return null;
    }
  }
}

// 单例导出
export const tokenChecker = new TokenChecker();
