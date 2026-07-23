/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { httpClient } from '../utils/http-client.js';
import {
  CertConstants,
  SignatureErrorMessages,
  SignatureHttpStatusCode,
  SignatureResponseSignals,
} from '../config/signature.js';

/**
 * 下载远端文件到本地。
 * - 4xx/5xx 不抛错：若 403 且 reason phrase = Openproxy 标记 → 网络错误（场景1）；
 *   否则按状态码非 200 → 下载失败。
 *
 * JAR 的 downloadFile 用 IOException msg.contains("403 Openproxy_Blocked_URL_list")，
 * 该串 = statusCode + " " + reasonPhrase。CLI 拆成 statusCode + statusText 判定。
 */
export async function downloadFile(
  downloadUrl: string,
  filePath: string
): Promise<void> {
  const { statusCode, statusText, buffer } = await httpClient.getBinaryAllowFailure(
    downloadUrl,
    { timeout: CertConstants.DOWNLOAD_CONNECT_TIMEOUT_MS }
  );
  if (statusCode !== 200) {
    if (
      statusCode === SignatureHttpStatusCode.FORBIDDEN &&
      statusText === SignatureResponseSignals.OPENPROXY_BLOCKED_URL
    ) {
      throw new Error(SignatureErrorMessages.ERR_CERT_NETWORK_ERROR);
    }
    throw new Error(SignatureErrorMessages.ERR_DOWNLOAD_CER);
  }
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, buffer);
}
