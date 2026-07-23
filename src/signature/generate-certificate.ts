/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { readFileSync } from 'node:fs';
import { SignatureErrorMessages } from '../config/signature.js';
import { Project } from '../utils/project.js';
import type { AuthInfo, GenerateCertificateResult } from './types.js';
import {
  addCertificate,
  buildAutoSignCerName,
  deleteRemoteCert,
  findCertByName,
  getDownloadUrl,
} from './cert-api.js';
import { downloadFile } from './download.js';
import { checkCertificateValidate, deleteLocalSignFiles } from './local-material.js';
import { generateP12AndCSR, getAutoSignFilePath } from './signature-tool.js';

/**
 * 生成 HarmonyOS 自动签名证书。
 * 步骤3 由 generateP12AndCSR 生成本地 p12 + csr，并读取 csr 内容供云侧新增证书。
 * 本地 cer 路径与 p12/csr 共用 getAutoSignFilePath 基名；
 * 云侧证书名仍用 auto_debug_<teamId>.cer（getAutoSignCerFileName）。
 */
export async function generateCertificate(
  auth: AuthInfo,
  productName?: string
): Promise<GenerateCertificateResult> {
  const product = productName ?? '';
  const projectRoot = Project.discover(process.cwd()).rootDir;

  await deleteLocalSignFiles(product, projectRoot);

  const certName = buildAutoSignCerName(auth.teamId);
  const existCert = await findCertByName(auth, certName);
  if (existCert) {
    const deleted = await deleteRemoteCert(auth, existCert.id);
    if (!deleted) {
      throw new Error(SignatureErrorMessages.ERR_DOWNLOAD_CER);
    }
  }

  const p12AndCsr = await generateP12AndCSR(productName);
  let csrContent: string;
  try {
    csrContent = readFileSync(p12AndCsr.csrFilePath, 'utf-8');
  } catch {
    throw new Error(SignatureErrorMessages.ERR_READ_CSR);
  }

  await addCertificate(auth, csrContent, certName);

  const newCert = await findCertByName(auth, certName);
  if (!newCert) {
    throw new Error(SignatureErrorMessages.ERR_DOWNLOAD_CER);
  }

  const downloadUrl = await getDownloadUrl(auth, newCert.certObjectId);
  if (!downloadUrl) {
    throw new Error(SignatureErrorMessages.ERR_DOWNLOAD_CER);
  }

  const cerFilePath = await getAutoSignFilePath(product, projectRoot, 'cer');
  await downloadFile(downloadUrl, cerFilePath);

  checkCertificateValidate(cerFilePath);

  return {
    p12FilePath: p12AndCsr.p12FilePath,
    csrFilePath: p12AndCsr.csrFilePath,
    cerFilePath,
    certId: newCert.id,
    keyAlias: p12AndCsr.keyAlias,
    keyPwd: p12AndCsr.keyPwd,
  };
}
