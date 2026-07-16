/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { layoutCommand } from './ui-layout.js';
import { windowCommand } from './ui-window.js';
import { screenshotCommand } from './ui-screenshot.js';
import {
  clickCommand,
  doubleclickCommand,
  longclickCommand,
  swipeCommand,
  flingCommand,
  dragCommand,
  dircflingCommand,
  textCommand,
} from './ui-input.js';

const uiCommand = new Command('ui').description(
  'Inspect and interact with UI on a connected device'
);

uiCommand.addCommand(layoutCommand);
uiCommand.addCommand(windowCommand);
uiCommand.addCommand(screenshotCommand);
uiCommand.addCommand(clickCommand);
uiCommand.addCommand(doubleclickCommand);
uiCommand.addCommand(longclickCommand);
uiCommand.addCommand(swipeCommand);
uiCommand.addCommand(flingCommand);
uiCommand.addCommand(dragCommand);
uiCommand.addCommand(dircflingCommand);
uiCommand.addCommand(textCommand);

export default uiCommand;
