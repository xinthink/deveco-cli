/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import compatCommand from '../compat/compat.js';

const checkCommand = new Command('check')
    .description('Run DevEco project checks.')
    .addCommand(compatCommand);

export default checkCommand;
