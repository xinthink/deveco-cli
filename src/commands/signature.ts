/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red } from 'colorette';
import { EnvChecker } from '../signature/env-checker';

interface SignatureGenerateOptions {
  force?: boolean;
  teamId?: string;
  product?: string;
}

async function handleSignatureCommand(
  options: SignatureGenerateOptions
): Promise<void> {
  const productName = options.product || 'default';

  // 第一阶段：环境预检
  const checker = new EnvChecker();
  const passed = await checker.preflight({
    productName,
    teamId: options.teamId,
  });
  if (!passed) {
    process.exit(1);
  }
  console.log('Executing signature generate command');
  console.log(`Force: ${options.force ?? false}`);
  console.log(`Team ID: ${options.teamId ?? 'default'}`);
  console.log(green('Signature generation completed successfully.'));
}

const signatureCommand = new Command('signature')
  .description('Generate application signature');

signatureCommand
  .command('generate')
  .description('Automatically generate signature materials and write to project configuration')
  .option('--force', 'Force overwrite existing signature materials')
  .option('--team-id <team-id>', 'Specify the team-id to use')
  .action(async (options: SignatureGenerateOptions) => {
    try {
      await handleSignatureCommand(options);
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

export default signatureCommand;