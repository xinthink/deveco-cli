/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, cyan } from 'colorette';
import { loginService } from '../auth/login-service';

const loginCommand = new Command('login')
  .description('Log in to your Huawei Developer account')
  .action(async () => {
    console.log(cyan('Starting login process...'));

    try {
      const userInfo = await loginService.login();
      console.log(
        green(`Login successful. Logged in as ${userInfo.userName}.`)
      );
    } catch (error) {
      const e = error as Error;
      console.error(red('✗ Login failed'));
      if (e.message) {
        console.error(red(`  Error: ${e.message}`));
      }
      process.exit(1);
    }
  });

export default loginCommand;
