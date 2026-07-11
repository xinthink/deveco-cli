/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { layoutCommand } from './ui-layout.js';
import { windowCommand } from './ui-window.js';
import { screenshotCommand } from './ui-screenshot.js';

const uiCommand = new Command('ui').description(
  'Inspect and interact with UI on a connected device'
);

uiCommand.addCommand(layoutCommand);
uiCommand.addCommand(windowCommand);
uiCommand.addCommand(screenshotCommand);

export default uiCommand;
