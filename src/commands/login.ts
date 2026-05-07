/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { green, red, cyan } from 'colorette';
import { loginService } from '../auth/login-service';

const loginCommand = new Command('login')
  .description('Login to DevEco account')
  .option('-c, --country <code>', 'Country code (CN, RU, SG, EU)', 'CN')
  .action(async (options) => {
    const countryCode = options.country?.toUpperCase() || 'CN';
    const validCountryCodes = ['CN', 'RU', 'SG', 'EU'];

    // 验证国家代码
    if (!validCountryCodes.includes(countryCode)) {
      console.log(
        red(
          `Invalid country code: ${countryCode}. Valid codes are: ${validCountryCodes.join(', ')}`
        )
      );
      process.exit(1);
    }

    console.log(cyan('Starting login process...'));
    console.log(`Country: ${countryCode}`);

    try {
      const userInfo = await loginService.login();
      console.log(green('Login successful!'));
      console.log(green(`Welcome, ${userInfo.userName}!`));
      console.log(green(`User ID: ${userInfo.userId}`));
    } catch (error) {
      const e = error as Error;
      console.log(red('Login failed'));
      if (e.message) {
        console.error(red(e.message));
      }
      process.exit(1);
    }
  });

export default loginCommand;
