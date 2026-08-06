/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { red, cyan } from 'colorette';
import * as readline from 'readline';
import { loginService, getTeamList, isDevecoCodeAuth, DefinedError, type Team } from '../auth';

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
    if (isDevecoCodeAuth()) {
      console.log(red('Login is managed by DevEco Code. Login from DevEco Code instead.'));
      return;
    }
    try {
      const userInfo = await loginService.getUserInfo();
      if (userInfo) {
        console.log(cyan(`Already logged in, User Name:${userInfo.userName}`));
        return;
      }
      console.log(cyan('Starting login process...'));
      console.log(cyan('Press Enter to open browser for login...'));
      await waitForEnter();
      const newUserInfo = await loginService.login();
      console.log(
        cyan(`Login successful. Logged in as ${newUserInfo.userName}.`)
      );
    } catch (error) {
      if (error instanceof DefinedError) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('Network connection failed')) {
        throw error;
      }
      throw new Error('Login failed', { cause: error });
    }
  });

authCommand
  .command('logout')
  .description('Log out of your Huawei Developer account')
  .action(async () => {
    if (isDevecoCodeAuth()) {
      console.log(red('Login is managed by DevEco Code. Log out from DevEco Code instead.'));
      return;
    }
    try {
      const loggedOut = await loginService.logout();
      if (loggedOut) {
        console.log(cyan('Logout successful'));
      } else {
        console.log(cyan('Already logged out.'));
      }
    } catch (error) {
      throw new Error('Logout failed', { cause: error });
    }
  });

authCommand
  .command('status')
  .description('Show the currently logged-in user')
  .action(async () => {
    const userInfo = await loginService.getUserInfo();
    if (!userInfo) {
      console.log(cyan('Not logged in'));
      return;
    }
    console.log(cyan(`Current user: ${userInfo.userName}`));
  });

const teamCommand = authCommand
  .command('team')
  .description('Team-related commands');

teamCommand
  .command('list')
  .description('List team accounts the current user has joined')
  .action(async () => {
    try {
      const result = await getTeamList();
      console.log(renderTeamTable(result.teamList));
    } catch (error) {
      if (error instanceof DefinedError) {
        console.log(red(error.message));
        return;
      }
      throw error;
    }
  });

export default authCommand;
