/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, cyan, yellow } from 'colorette';
import { loginService } from '../auth/login-service';
import * as readline from 'readline';

/**
 * Wait for user to press Enter
 */
function waitForEnter(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

const loginCommand = new Command('login')
  .description('Log in to your Huawei Developer account')
  .action(async () => {
    try {
      // Check if already logged in
      const isLoggedIn = await loginService.isLoggedIn();
      if (isLoggedIn) {
        const userInfo = await loginService.getUserInfo();
        if (userInfo) {
          console.log(yellow(`Already logged in, User Name:${userInfo.userName}`));
          return;
        }
      }
      console.log(cyan('Starting login process...'));
      console.log(cyan('Press Enter to open browser for login...'));
      await waitForEnter();
      const userInfo = await loginService.login();
      console.log(
        green(`Login successful. Logged in as ${userInfo.userName}.`)
      );
    } catch (error) {
      const e = error as Error;
      console.error(red('Login failed'));
      if (e.message) {
        console.error(red(`  Error: ${e.message}`));
      }
      process.exit(1);
    }
  });

export default loginCommand;
