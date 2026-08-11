/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import querystring from 'querystring';
import { httpClient } from '../../utils/http-client';
import { debugLog } from '../../utils/logger';
import { AgreementConfig } from '../auth-config';

/**
 * 登录成功后上报隐私协议已签署（非阻塞，失败不影响登录）
 * @param accessToken 用户的 accessToken
 */
export function reportAgreementSigned(accessToken: string): void {
  const signReq = JSON.stringify({
    signInfo: [
      { agrType: AgreementConfig.PRIVACY_ID, country: 'CN', language: 'zh_CN', isAgree: true },
    ],
  });
  const body = querystring.stringify({
    nsp_svc: 'as.user.sign',
    access_token: accessToken,
    request: signReq,
  });

  httpClient.post(AgreementConfig.TMS_URL, {
    params: body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  }).then(() => {
    debugLog('Agreement sign reported successfully');
  }).catch((err) => {
    debugLog(`Agreement sign failed: ${(err as Error).message}`);
  });
}

/**
 * 查询协议签署状态
 * @param accessToken 用户的 accessToken
 */
export async function queryAgreementStatus(accessToken: string): Promise<string> {
  const queryReq = JSON.stringify({
    obtainVersion: true,
    agrInfo: [
      { agrType: AgreementConfig.PRIVACY_ID, country: 'CN', signType: 0, branchId: 0 },
    ],
  });
  const body = querystring.stringify({
    nsp_svc: 'as.user.query',
    access_token: accessToken,
    request: queryReq,
  });

  const response = await httpClient.post(AgreementConfig.TMS_URL, {
    params: body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });
  return typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
}