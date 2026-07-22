/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { join } from 'node:path';

/**
 * 签名服务相关端点
 */
export const SignatureEndpoints = {
  /** 签名使用的 base url */
  BASE_URL: 'https://connect-api.cloud.huawei.com',

  /** 证书列表查询路径 */
  CERT_LIST_PATH: '/api/cps/harmony-cert-manage/v1/cert/list',

  /** 证书删除路径 */
  CERT_DELETE_PATH: '/api/cps/harmony-cert-manage/v1/cert/delete',

  /** 证书添加路径 */
  CERT_ADD_PATH: '/api/cps/harmony-cert-manage/v1/cert/add',

  /** 证书下载链接申请路径 */
  CERT_DOWNLOAD_URL_PATH: '/api/amis/app-manage/v1/objects/url/reapply',
} as const;

/**
 * 证书相关常量
 */
export const CertConstants = {
  /** 自动 debug 签名生成的证书名称前缀 */
  CERT_NAME_PREFIX: 'auto_debug_',

  /** 证书类型：1=debug 证书，2=release 证书 */
  CERT_TYPE_DEBUG: '1',

  /** teamId 中的非法字符 */
  TEAM_ID_INVALID_CHARS: /[\\/.:]/g,

  /** 证书格式规范 */
  CERT_PATTERN: /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/,

  /** 证书保存目录（相对用户主目录） */
  CERT_SAVE_DIR: join('.ohos', 'config'),

  /** 下载连接超时（ms） */
  DOWNLOAD_CONNECT_TIMEOUT_MS: 5000,
} as const;

/**
 * 云侧响应判定常量（对齐 AutoSigningConfigsService）
 */
export const SignatureResponseSignals = {
  /** 响应体含此子串表示成功 */
  SUCCESS_MARKER: '"code":0',

  /** statusCode=403 时 reason phrase 精确匹配此串 */
  OPENPROXY_BLOCKED_URL: 'Openproxy_Blocked_URL_list',

  /** 响应体含此 ret.code 表示证书数量上限 */
  CERT_LIMIT_CODE: '205389872',

  /** 响应体含此 ret.code 表示非 Harmony 用户（USER_NOT_HARMONY_ALLOW） */
  USER_NOT_HARMONY_CODE: '205389904',
} as const;

/**
 * HTTP 状态码
 */
export const SignatureHttpStatusCode = {
  FORBIDDEN: 403,
  UNAUTHORIZED: 401,
} as const;

/**
 * 签名相关错误信息
 */
export const SignatureErrorMessages = {
  ERR_FORBIDDEN:
    'You do not have AppGallery Connect permissions for the current team. Request access from the team administrator or switch to a team where you have permissions.',

  ERR_UNAUTHORIZED: 'Invalid AccessToken. Sign in and try again.',

  ERR_CERT_LIMIT_REACHED:
    'The number of certificates has reached the limit. Delete some certificates and try again.',

  ERR_CERT_NETWORK_ERROR:
    'Ensure the external network connection is available before downloading the certificate.',

  ERR_CERT_INVALIDATE: 'The downloaded .cer file is invalid. Try again.',

  ERR_DOWNLOAD_CER:
    'Failed to download the certificate file. Check the following configurations: Network connection, HTTP Proxy, etc.',

  ERR_USER_NOT_HARMONY:
    'The user is not in harmony allow list, please grant the permission',

  ERR_READ_CSR: 'Failed to read the .csr file, please try again later',
} as const;
