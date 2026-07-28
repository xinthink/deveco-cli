/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as crypto from 'crypto';
import { LocalAuthServer } from './local-auth-server';
import { tokenStorage, getTokenSource } from '../utils/token-storage';
import type { UserInfo, LoginConfig } from '../types/auth-types';
import { getRegionalizedBaseUrl } from '../utils/region';
import { DEFAULT_LOGIN_CONFIG } from '../auth-config';
import { openBrowser } from './browser';
import { tokenChecker } from '../utils/token-checker';
import { userInfoFetcher } from './user-info-fetcher';
import { httpClient } from '../../utils/http-client';

/**
 * 登录服务类
 * 负责处理用户认证、Token 管理和会话维护
 *
 */
export class LoginService {
  private config: LoginConfig;
  private server: LocalAuthServer | null = null;

  /**
   * 创建登录服务实例
   * @param config 可选的配置参数，会与默认配置合并
   */
  constructor(config?: Partial<LoginConfig>) {
    this.config = { ...DEFAULT_LOGIN_CONFIG, ...config };
  }

  /**
   * 更新配置（用于动态更改国家代码等）
   */
  public updateConfig(config: Partial<LoginConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取当前配置
   */
  public getConfig(): LoginConfig {
    return { ...this.config };
  }

  /**
   * 执行登录流程
   * 1. 启动本地认证服务器
   * 2. 打开浏览器登录页面
   * 3. 等待用户完成登录
   * 4. 获取并保存 JWT Token
   * @returns 用户信息
   * @throws 如果登录过程中发生错误
   */
  public async login(): Promise<UserInfo> {
    try {
      const clientSecret = this.generateClientSecret();

      this.server = new LocalAuthServer(
        clientSecret,
        this.getRegionalizedBaseUrl(),
        this.config.successRedirectUrl,
        this.config.failedRedirectUrl
      );
      await this.server.start();

      await this.openLoginPage(this.server.getPort(), clientSecret);

      const callbackData = await this.server.waitForCallback(
        this.config.timeout
      );

      // 海外账户不在支持范围内
      if (callbackData.siteId !== '1') {
        throw new Error('Non-China accounts are not supported.');
      }

      const jwtToken = await userInfoFetcher.getJwtToken(
        callbackData.tempToken,
        callbackData.siteId,
        () => this.getRegionalizedBaseUrl(),
        this.config.tempTokenCheckUrl,
        this.config.appId
      );

      const userInfo = await userInfoFetcher.getUserInfoFromJwt(
        jwtToken,
        (token) =>
          tokenChecker.checkJwtToken(
            token,
            () => this.getRegionalizedBaseUrl(),
            this.config.jwtTokenCheckUrl
          )
      );

      // 保存 jwtToken 到磁盘
      await tokenStorage.saveJwtToken(jwtToken);

      return userInfo;
    } finally {
      if (this.server) {
        // 不等待 stop() 完成，让它在后台异步执行
        await this.server.stop();
        this.server = null;
      }
    }
  }

  /**
   * 检查用户是否已登录
   * @returns 如果已登录返回 true，否则返回 false
   */
  public async isLoggedIn(): Promise<boolean> {
    const jwtToken = await tokenStorage.loadJwtToken();
    if (!jwtToken) {
      return false;
    }
    const res = await tokenChecker.checkJwtToken(
      jwtToken,
      () => this.getRegionalizedBaseUrl(),
      this.config.jwtTokenCheckUrl
    );
    if (res.status) {
      return true;
    }
    // jwtToken失效，需要重新登录
    if (getTokenSource() === 'deveco-cli') {
      await tokenStorage.clearToken();
    }
    return false;
  }

  /**
   * 执行登出操作
   * 清除本地存储的 Token
   * @throws If not logged in
   */
  public async logout(): Promise<boolean> {
    const jwtToken = await tokenStorage.loadJwtToken();
    if (!jwtToken) {
      return false;
    }
    const regionalizedBaseUrl = this.getRegionalizedBaseUrl();
    const logoutUrl = `${regionalizedBaseUrl}/${this.config.logoutUrl}?jwtToken=${jwtToken}`;
    try {
      await httpClient.post(logoutUrl, { timeout: 5000 });
    } finally {
      await tokenStorage.clearToken();
    }
    return true;
  }

  /**
   * 获取当前会话信息
   * 从磁盘的 JWT Token 解析用户信息
   * @returns 会话信息对象，如果未登录则返回 null
   */
  public async getUserInfo(): Promise<UserInfo | null> {
    const jwtToken = await tokenStorage.loadJwtToken();
    if (!jwtToken) {
      return null;
    }
    return userInfoFetcher.getUserInfoFromJwt(jwtToken, (token) =>
      tokenChecker.checkJwtToken(
        token,
        () => this.getRegionalizedBaseUrl(),
        this.config.jwtTokenCheckUrl
      )
    );
  }

  /**
   * 生成客户端密钥
   * @returns UUID 格式的密钥（去除连字符）
   */
  private generateClientSecret(): string {
    return crypto.randomUUID().replace(/-/g, '');
  }

  /**
   * 获取区域化的基础 URL
   * 根据国家代码返回对应的 API 端点
   * @returns 区域化的基础 URL
   */
  private getRegionalizedBaseUrl(): string {
    return getRegionalizedBaseUrl(
      this.config.countryCode ?? '',
      this.config.baseUrl
    );
  }

  /**
   * 打开浏览器登录页面
   * @param port 本地认证服务器端口
   * @param clientSecret 客户端密钥
   */
  private async openLoginPage(
    port: number,
    clientSecret: string
  ): Promise<void> {
    const regionalizedBaseUrl = this.getRegionalizedBaseUrl();
    const loginUrl = `${regionalizedBaseUrl}/${this.config.authUrl}?port=${port}&appid=${this.config.appId}&code=${clientSecret}`;
    await openBrowser(loginUrl);
  }

  /**
   * 刷新 accessToken
   * 从磁盘加载 JWT Token 并刷新
   */
  async refreshToken(): Promise<{
    accessToken: string;
    refreshToken: string;
  } | null> {
    return tokenChecker.refreshToken(
      () => this.getRegionalizedBaseUrl(),
      this.config.jwtTokenCheckUrl
    );
  }
}

// ============ Singleton instance ============
export const loginService = new LoginService();
