/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { red, cyan } from 'colorette';
import * as readline from 'readline';
import { loginService, tokenStorage, getTeamList, type Team } from '../auth';
import { httpClient } from '../utils/http-client';
import { getRegionalizedBaseUrl } from '../auth/utils/region';
import { ApiEndpoints } from '../config/constants';

function renderTeamTable(teams: Team[]): string {
  if (teams.length === 0) {
    return cyan('No teams found for the current user.');
  }
  const header = ['Id', 'Name'];
  const rows = teams.map((team) => [team.id, team.name]);
  const widths = header.map((cell, idx) =>
    Math.max(cell.length, ...rows.map((row) => row[idx].length))
  );
  const fmt = (cells: string[]): string =>
    cells.map((cell, idx) => cell.padEnd(widths[idx])).join('  ');
  const sep = widths.map((width) => '-'.repeat(width)).join('  ');
  return [fmt(header), sep, ...rows.map(fmt)].join('\n');
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('', () => {
      rl.close();
      resolve();
    });
  });
}

const authCommand = new Command('auth').description(
  'Authentication commands (login, logout, status, team)'
);

authCommand
  .command('login')
  .description('Log in to your Huawei Developer account')
  .action(async () => {
    try {
      const isLoggedIn = await loginService.isLoggedIn();
      if (isLoggedIn) {
        const userInfo = await loginService.getUserInfo();
        if (userInfo) {
          console.log(cyan(`Already logged in, User Name:${userInfo.userName}`));
          return;
        }
      }
      console.log(cyan('Starting login process...'));
      console.log(cyan('Press Enter to open browser for login...'));
      await waitForEnter();
      const userInfo = await loginService.login();
      console.log(
        cyan(`Login successful. Logged in as ${userInfo.userName}.`)
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

authCommand
  .command('logout')
  .description('Log out of your Huawei Developer account')
  .action(async () => {
    const jwtToken = await tokenStorage.loadJwtToken();
    if (jwtToken == null) {
      console.log(cyan('Already logged out.'));
      return;
    }
    let serverError: Error | null = null;
    try {
      const url =
        `${getRegionalizedBaseUrl('CN', ApiEndpoints.LOGIN_URL)}` +
        `/${ApiEndpoints.LOGOUT_PATH}?jwtToken=${jwtToken}`;
      await httpClient.post(url, { timeout: 5000 });
    } catch (e) {
      serverError = e as Error;
    }
    await tokenStorage.clearToken();
    if (serverError) {
      console.error(red(`Logout partially failed: ${serverError.message}`));
      console.error(
        red('Local token cleared. Run `devecocli auth logout` again to retry server-side.')
      );
      process.exit(2);
    }
    console.log(cyan('Logout successful'));
  });

authCommand
  .command('status')
  .description('Show the currently logged-in user')
  .action(async () => {
    try {
      const isLoggedIn = await loginService.isLoggedIn();
      if (!isLoggedIn) {
        console.log(cyan('Not logged in'));
        return;
      }
      const userInfo = await loginService.getUserInfo();
      if (!userInfo) {
        console.log(cyan('Not logged in'));
        return;
      }
      console.log(cyan(`Current user: ${userInfo.userName}`));
    } catch {
      console.log(cyan('Not logged in'));
    }
  });

const teamCommand = authCommand
  .command('team')
  .description('Team-related commands');

teamCommand
  .command('list')
  .description('List team accounts the current user has joined')
  .option('--json', 'output as JSON', false)
  .action(async (options: { json: boolean }) => {
    try {
      const isLoggedIn = await loginService.isLoggedIn();
      if (!isLoggedIn) {
        console.log(cyan('Please run `devecocli auth login` first.'));
        return;
      }
      const result = await getTeamList();
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(renderTeamTable(result.teamList));
    } catch (error) {
      console.error(red((error as Error).message));
      process.exit(1);
    }
  });

export default authCommand;
