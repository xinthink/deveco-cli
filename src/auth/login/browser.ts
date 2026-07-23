/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * 打开浏览器
 * @param url 要打开的 URL
 * @throws Error 如果打开浏览器失败
 */
export async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  let command: string;

  switch (platform) {
    case 'win32':
      command = `start "" "${url}"`;
      break;
    case 'darwin':
      command = `open "${url}"`;
      break;
    default:
      command = `xdg-open "${url}"`;
      break;
  }

  try {
    await execAsync(command);
  } catch (err) {
    throw new Error('Failed to open browser', { cause: err });
  }
}
