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

interface ExecFileError extends Error {
  stdout?: string;
  stderr?: string;
  code?: number | string;
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
  } catch (err: unknown) {
    const error = err as ExecFileError;
    return {
      stdout: error.stdout?.trim() || '',
      stderr: error.stderr?.trim() || error.message,
      exitCode: typeof error.code === 'number' ? error.code : 1,
    };
  }
}
