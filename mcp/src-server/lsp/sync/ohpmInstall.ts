/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';

function getOsType(): string {
    const p = process.platform;
    if (p === 'win32') {
        return 'Windows';
    }
    if (p === 'darwin') {
        return 'Mac';
    }
    return 'Linux';
}

const OHPM_ARGS = 'install --all --registry https://ohpm.openharmony.cn/ohpm/ --strict_ssl true';

function findOhpmPath(sdk: string, osType: string): string | null {
    const toolsDir = sdk.replace(/sdk\/?$/i, 'tools');
    const ohpmBin = osType === 'Windows' ? 'ohpm.bat' : 'ohpm';

    // DevEco Studio 风格: tools/ohpm/bin/ohpm
    let ohpmPath = path.join(toolsDir, 'ohpm', 'bin', ohpmBin);
    if (fs.existsSync(ohpmPath)) {
        return ohpmPath;
    }

    // command-line-tools 风格: ohpm/bin/ohpm
    let sdkPath = sdk.toLowerCase().endsWith('sdk') ? path.dirname(sdk) : sdk;
    ohpmPath = path.join(sdkPath, 'ohpm', 'bin', ohpmBin);
    return fs.existsSync(ohpmPath) ? ohpmPath : null;
}

function runOhpmCommand(ohpmPath: string, projectPath: string, osType: string): { exitCode: number; output: string } {
    const isWindows = osType === 'Windows';
    const escapedProject = projectPath.replace(/'/g, isWindows ? "''" : "'\\''");
    const escapedOhpm = ohpmPath.replace(/'/g, isWindows ? "''" : "'\\''");

    const result = isWindows
        ? spawnSync('powershell.exe', ['-Command', `cd '${escapedProject}'; & '${escapedOhpm}' ${OHPM_ARGS}`], {
              cwd: projectPath,
              encoding: 'utf8',
              windowsHide: true,
          })
        : spawnSync('bash', ['-c', `cd '${escapedProject}' && '${escapedOhpm}' ${OHPM_ARGS}`], {
              cwd: projectPath,
              encoding: 'utf8',
          });

    const stdout = (result.stdout ?? '') as string;
    const stderr = (result.stderr ?? '') as string;
    const output = [stdout, stderr].filter(Boolean).join('\n');
    return { exitCode: result.status ?? -1, output };
}

function logOhpmOutput(output: string): void {
    output.split(/\r?\n/).filter(Boolean).forEach((line) => logger.info('[ohpm] %s', line));
}

/**
 * 安装所有依赖（同步，对应 Java ohpmInstallAll）
 * @param projectPath 项目路径
 * @param sdk DevEco SDK 路径，用于推导 ohpm 路径
 * @returns 是否成功
 */
export function ohpmInstallAll(projectPath: string, sdk: string): boolean {
    try {
        const osType = getOsType();
        const ohpmPath = findOhpmPath(sdk, osType);
        if (!ohpmPath) {
            logger.error('ohpm 不存在');
            return false;
        }

        const { exitCode, output } = runOhpmCommand(ohpmPath, projectPath, osType);
        logOhpmOutput(output);

        if (exitCode === 0) {
            logger.info('ohpm 安装成功');
            return true;
        }
        logger.error('ohpm 安装失败，退出码: %s', exitCode);
        logger.error('ohpm 输出: %s', output);
        return false;
    } catch (e) {
        logger.error('ohpm 安装异常', e as Error);
        return false;
    }
}
