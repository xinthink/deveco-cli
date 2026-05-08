/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { NetworkConstants, TimeConstants } from './network';

/**
 * 应用配置常量
 */
export const AppConfig = {
  /** 应用 ID */
  APP_ID: '1007',

  /** 配置目录名称 */
  CONFIG_DIR_NAME: '.config',

  /** 应用名称 */
  APP_NAME: 'deveco-cli',

  /** Token 文件名 */
  TOKEN_FILE_NAME: 'token.enc',

  /** 密钥文件名 */
  KEY_FILE_NAME: '.token_key',

  /** API 版本号 */
  API_VERSION: '1.0.0',
} as const;


export const ApiEndpoints = {
  LOGIN_URL: 'https://devecostudio.huawei.com',

  CN_LOGIN_URL: 'https://cn.devecostudio.huawei.com',

  AUTH_APPLY_PATH: 'console/DevEcoIDE/apply',

  TEMP_TOKEN_CHECK_PATH: 'authrouter/auth/api/temptoken/check',

  JWT_TOKEN_CHECK_PATH: 'authrouter/auth/api/jwToken/check',

  LOGIN_SUCCESS_PATH: 'console/DevEcoIDE/loginSuccess',

  LOGIN_FAILED_PATH: 'console/DevEcoIDE/loginFailed',

  LOGOUT_PATH: 'authrouter/auth/api/logout',
} as const;

export const CryptoConstants = {
  /** 加密算法 */
  ALGORITHM: 'aes-128-gcm',

  /** 密钥长度（字节） */
  KEY_LENGTH: 16,

  /** IV 长度（字节） */
  IV_LENGTH: 12,
} as const;

/**
 * 默认登录配置
 */
export const DEFAULT_LOGIN_CONFIG = {
  baseUrl: ApiEndpoints.LOGIN_URL,
  authUrl: ApiEndpoints.AUTH_APPLY_PATH,
  tempTokenCheckUrl: ApiEndpoints.TEMP_TOKEN_CHECK_PATH,
  jwtTokenCheckUrl: ApiEndpoints.JWT_TOKEN_CHECK_PATH,
  successRedirectUrl: ApiEndpoints.LOGIN_SUCCESS_PATH,
  failedRedirectUrl: ApiEndpoints.LOGIN_FAILED_PATH,
  logoutUrl: ApiEndpoints.LOGOUT_PATH,
  appId: AppConfig.APP_ID,
  defaultPort: NetworkConstants.DEFAULT_AUTH_PORT,
  timeout: TimeConstants.LOGIN_TIMEOUT_MS,
  countryCode: 'CN',
} as const;