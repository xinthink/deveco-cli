export interface AuthInfo {
  uid: string;
  teamId: string;
  accessToken: string;
}

export interface CertInfo {
  id: string;
  certName: string;
  certObjectId: string;
}

export interface CertListResponse {
  certList: CertInfo[];
}

export interface DownloadUrlList {
  urlsInfo: { newUrl: string }[];
}

export interface GenerateCertificateResult {
  /** p12 密钥库绝对路径 */
  p12FilePath: string;
  /** csr 证书请求绝对路径 */
  csrFilePath: string;
  /** 下载的 .cer 证书绝对路径 */
  cerFilePath: string;
  /** 云侧证书 id（HarmonyCertInfo.getId()，用于后续生成 profile） */
  certId: string;
  /** 密钥别名 */
  keyAlias: string;
  /** 明文密钥【高度敏感，禁止打印/持久化日志】 */
  keyPwd: string;
}
