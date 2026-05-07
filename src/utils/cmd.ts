/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execFile, ExecFileOptions } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function runCommand(
  command: string,
  args: string[] = [],
  options: ExecFileOptions = {}
): Promise<CommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, options);
    return {
      stdout: typeof stdout === 'string' ? stdout.trim() : '',
      stderr: typeof stderr === 'string' ? stderr.trim() : '',
      exitCode: 0,
    };
  } catch (error: any) {
    return {
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || error.message,
      exitCode: error.code || 1,
    };
  }
}
