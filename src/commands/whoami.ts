/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, cyan } from 'colorette';
import { loginService } from '../auth/login-service';

const whoamiCommand = new Command('whoami')
  .description('Display current logged-in user information')
  .action(async () => {
    try {
      // 检查是否已登录
      const isLoggedIn = await loginService.isLoggedIn();
      if (!isLoggedIn) {
        console.log(red('Please run `deveco login` first.'));
        process.exit(1);
      }

      // 获取用户信息
      const userInfo = await loginService.getUserInfo();
      if (!userInfo) {
        console.log(red('Failed to get user information.'));
        process.exit(1);
      }

      // 输出用户信息
      console.log(cyan('Current user:'));
      console.log(green(`  User Name: ${userInfo.userName}`));
      console.log(green(`  User ID: ${userInfo.userId}`));
    } catch (error) {
      const e = error as Error;
      console.log(red('Failed to get user information'));
      if (e.message) {
        console.error(red(`  Error: ${e.message}`));
      }
      process.exit(1);
    }
  });

export default whoamiCommand;
