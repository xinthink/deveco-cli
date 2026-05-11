/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, cyan } from 'colorette';
import { loginService } from '../auth/login-service';

const whoamiCommand = new Command('whoami')
  .description('Show the currently logged-in user')
  .action(async () => {
    try {
      // 检查是否已登录
      const isLoggedIn = await loginService.isLoggedIn();
      if (!isLoggedIn) {
        console.error(red('Not logged in. Run `deveco login` first.'));
        process.exit(1);
      }

      // 获取用户信息
      const userInfo = await loginService.getUserInfo();
      if (!userInfo) {
        console.error(red('Failed to retrieve user information.'));
        process.exit(1);
      }

      // 输出用户信息
      console.log(cyan('Current user:'));
      console.log(green(`  User Name: ${userInfo.userName}`));
      console.log(green(`  User ID:   ${userInfo.userId}`));
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

export default whoamiCommand;
