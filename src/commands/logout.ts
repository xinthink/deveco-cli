/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red } from 'colorette';
import { loginService } from '../auth/login-service';

const logoutCommand = new Command('logout')
  .description('Logout from DevEco account')
  .action(async () => {
    try {
      await loginService.logout();
      console.log(green('Logged out successfully!'));
    } catch (error) {
      const e = error as Error;
      console.log(red('Logout failed'));
      if (e.message) {
        console.error(red(e.message));
      }
      process.exit(1);
    }
  });

export default logoutCommand;
