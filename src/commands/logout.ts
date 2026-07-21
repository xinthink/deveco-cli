/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red } from 'colorette';
import { loginService } from '../auth/login-service';

const logoutCommand = new Command('logout')
  .description('Log out of your Huawei Developer account')
  .action(async () => {
    try {
      await loginService.logout();
      console.log(green('Logout successful'));
    } catch (error) {
      const e = error as Error;
      console.error(red(`Logout failed: ${e.message}`));
      if (e.message) {
        console.error(red(e.message));
      }
      process.exit(1);
    }
  });

export default logoutCommand;
