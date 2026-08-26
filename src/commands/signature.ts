/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red } from 'colorette';
import fs from 'node:fs';
import path from 'node:path';
import json5 from 'json5';
import type {
  AuthInfo,
  GenerateCertificateResult,
} from '../signature';
import { generateCertificate, ReGenerateSign } from '../signature';
import { DEFAULT_CFG } from '../signature/signature-tool.js';
import { KeyManager } from '../signature/key-manager.js';
import { ToolProvider } from '../toolchain';
import { Project } from '../utils/project.js';
import { AutoSignOptions } from '../signature/types.js';
import { getAutoSignProjectReqPermissions } from '../signature/acl-permission-manager.js';
import { registerDevice } from '../signature/device-manager.js';
import { generateTestProfileFile } from '../signature/generate-profile.js';
import { aclPermissionsUsingWarn } from '../signature/acl-permission-warn.js';
import { EnvChecker } from '../signature/env-checker.js';
import { loginService } from '../auth';
import { telemetry, EventType, toTraceErrorCode, type CommandExecuted, type TrackMeasurement } from '../trace/index.js';

interface SignatureGenerateOptions {
  force?: boolean;
  teamId?: string;
  product?: string;
}

interface SigningConfigMaterial {
  certpath: string;
  keyAlias: string;
  keyPassword: string;
  profile: string;
  signAlg: string;
  storeFile: string;
  storePassword: string;
}

interface SigningConfig {
  name: string;
  type: string;
  material: SigningConfigMaterial;
}

const MAX_PROFILE_SIZE = 5 * 1024 * 1024;

function readOrCreateProfile(profilePath: string): {
  app?: {
    signingConfigs?: SigningConfig[];
    products?: Array<{ name: string; signingConfig?: string }>;
  };
} {
  try {
    const stat = fs.statSync(profilePath);
    if (stat.size > MAX_PROFILE_SIZE) {
      throw new Error(`Profile file too large: ${stat.size} bytes (max ${MAX_PROFILE_SIZE} bytes): ${profilePath}`);
    }
    const content = fs.readFileSync(profilePath, 'utf-8');
    return json5.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { app: { signingConfigs: [], products: [] } };
    }
    throw new Error(`Failed to read profile: ${profilePath}`, { cause: error });
  }
}

function ensureProfileStructure(profile: {
  app?: {
    signingConfigs?: SigningConfig[];
    products?: Array<{ name: string; signingConfig?: string }>;
  };
}): void {
  if (!profile.app) {
    profile.app = { signingConfigs: [], products: [] };
  }
  if (!profile.app.signingConfigs) {
    profile.app.signingConfigs = [];
  }
  if (!profile.app.products) {
    profile.app.products = [];
  }
}

async function encryptSigningPasswords(
  result: GenerateCertificateResult
): Promise<{ keyPassword: string; storePassword: string }> {
  if (result.keyPwd === result.storePassword) {
    const encrypted = await KeyManager.encryptedPassword(
      result.keyPwd,
      result.p12FilePath
    );
    return { keyPassword: encrypted, storePassword: encrypted };
  }

  const encryptedKeyPassword = await KeyManager.encryptedPassword(
    result.keyPwd,
    result.p12FilePath
  );
  const encryptedStorePassword = await KeyManager.encryptedPassword(
    result.storePassword,
    result.p12FilePath
  );

  return {
    keyPassword: encryptedKeyPassword,
    storePassword: encryptedStorePassword,
  };
}

async function writeSigningConfigToProject(
  projectRoot: string,
  result: GenerateCertificateResult,
  productName: string
): Promise<void> {
  const profilePath = path.join(projectRoot, 'build-profile.json5');
  const profile = readOrCreateProfile(profilePath);
  ensureProfileStructure(profile);

  const configName = productName ?? 'default';
  const { keyPassword, storePassword } = await encryptSigningPasswords(result);

  const signingConfig: SigningConfig = {
    name: configName,
    type: 'HarmonyOS',
    material: {
      certpath: result.cerFilePath,
      keyAlias: result.keyAlias,
      keyPassword,
      profile: result.profileFilePath,
      signAlg: DEFAULT_CFG.signAlg,
      storeFile: result.p12FilePath,
      storePassword,
    },
  };

  const existingIndex = profile.app?.signingConfigs?.findIndex(
    (config) => config.name === configName
  );

  if (existingIndex !== undefined && existingIndex >= 0) {
    profile.app!.signingConfigs![existingIndex] = signingConfig;
  } else {
    profile.app!.signingConfigs!.push(signingConfig);
  }

  const productIndex = profile.app?.products?.findIndex(
    (product) => product.name === configName
  );

  if (productIndex !== undefined && productIndex >= 0) {
    profile.app!.products![productIndex].signingConfig = configName;
  } else {
    profile.app!.products!.push({
      name: configName,
      signingConfig: configName,
    });
  }

  fs.writeFileSync(profilePath, json5.stringify(profile, null, 2), 'utf-8');
}

async function getAuthInfo(
  options: SignatureGenerateOptions
): Promise<AuthInfo> {
  const userInfo = await loginService.getUserInfo();
  const token = await loginService.refreshToken();
  if (!userInfo || !token) {
    throw new Error(
      'Failed to obtain login credentials. Run `devecocli auth login` again.'
    );
  }
  return {
    uid: userInfo.userId ?? '',
    teamId: options.teamId ?? userInfo.userId ?? '',
    accessToken: token.accessToken ?? '',
  };
}

async function handleSignatureCommand(options: SignatureGenerateOptions): Promise<void> {
  const productName = options.product || 'default';

  /** 环境预检（检测失败时抛出错误，由上层进行打点后统一处理） */
  const checker = new EnvChecker();
  await checker.preflight({
    productName,
    teamId: options.teamId,
  });
  console.log('Executing signature generate command');

  /** 判断是否重新生成签名材料 */
  const authInfo = await getAuthInfo(options);
  const toolProvider = await ToolProvider.new();
  const { shouldRegenerate: needRegen } = await ReGenerateSign.shouldRegenerate(
    {
      force: options.force ?? false,
      teamId: authInfo.teamId,
      productName: options.product,
    },
    toolProvider
  );
  if (!needRegen) {
    console.log(green('Signature generation completed successfully.'));
    return;
  }

  await generateAndWriteSigningConfig(options, authInfo, toolProvider);
  console.log(green('Signature generation completed successfully.'));
}

async function generateAndWriteSigningConfig(
  options: SignatureGenerateOptions,
  authInfo: AuthInfo,
  toolProvider: ToolProvider
): Promise<void> {
  const result = await generateCertificate(authInfo, options.product);

  const autoSignOptions = getAutoSignOptions(options, authInfo, result, toolProvider);
  autoSignOptions.allDeviceIds = await registerDevice(authInfo, toolProvider.hdcPath);
  await generateTestProfileFile(authInfo, autoSignOptions);

  const projectRoot = Project.discover(process.cwd()).rootDir;
  await writeSigningConfigToProject(projectRoot, result, options.product ?? 'default');
  console.log(green(`Signing config written to ${path.join(projectRoot, 'build-profile.json5')}`));
}

function getAutoSignOptions(
  options: SignatureGenerateOptions,
  authInfo: AuthInfo,
  certRes: GenerateCertificateResult,
  toolProvider: ToolProvider
): AutoSignOptions {
  const currentDir = process.cwd();
  const project = Project.discover(currentDir);
  const aclPermissionsSet = getAutoSignProjectReqPermissions(
    project,
    toolProvider
  );
  aclPermissionsUsingWarn(aclPermissionsSet, project);

  return {
    productName: options.product || 'default',
    bundleName: project.getBundleName(options.product || 'default'),
    projectPath: project.rootDir,
    teamId: authInfo.teamId,
    force: options.force || false,
    aclPermissionList: [...aclPermissionsSet],
    certIds: [certRes.certId],
    keyAlias: certRes.keyAlias,
    keyPwd: certRes.keyPwd,
  };
}

const signatureCommand = new Command('signature').description(
  'Generate application signature.'
);

signatureCommand
  .command('generate')
  .description(
    'Automatically generate signing materials and write them to the project configuration.'
  )
  .option('--force', 'Force overwrite existing local signing materials.')
  .option('--team-id <team-id>', 'Specify the team ID to use.')
  .option(
    '--product <product>',
    'Specify the product. The default value is default.'
  )
  .action(async (options: SignatureGenerateOptions) => {
    const event: CommandExecuted = {
      event: EventType.CommandExecuted,
      args: [
        'signature', 'generate',
        ...(options.force ? ['--force'] : []),
        ...(options.teamId ? ['--team-id'] : []),
        ...(options.product ? ['--product'] : []),
      ],
    };
    const start = Date.now();
    let success = true;
    let errorCode: string | null = null;
    try {
      await handleSignatureCommand(options);
    } catch (error) {
      success = false;
      errorCode = toTraceErrorCode(error);
      console.error(red((error as Error).message));
      process.exitCode = 1;
    } finally {
      const measurement: TrackMeasurement = {
        duration_ms: Date.now() - start,
        success,
        error_code: errorCode,
      };
      await telemetry.track(event, measurement);
    }
  });

export default signatureCommand;
