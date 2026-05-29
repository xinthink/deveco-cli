/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import { findNodePath } from '../../utils/common.js';

const OHPM_ARGS = ['install', '--all'];

function findOhpmJsPath(sdk: string): string | null {
    const toolsDir = sdk.replace(/sdk\/?$/i, 'tools');

    let ohpmPath = path.join(toolsDir, 'ohpm', 'bin', 'pm-cli.js');
    if (fs.existsSync(ohpmPath)) {
        return ohpmPath;
    }

    const sdkPath = sdk.toLowerCase().endsWith('sdk') ? path.dirname(sdk) : sdk;
    ohpmPath = path.join(sdkPath, 'ohpm', 'bin', 'pm-cli.js');
    return fs.existsSync(ohpmPath) ? ohpmPath : null;
}

async function runOhpmCommand(nodePath: string, ohpmJsPath: string, projectPath: string, sdkPath: string): Promise<{ exitCode: number; output: string }> {
    return new Promise<{ exitCode: number; output: string }>((resolve) => {
        const child = spawn(nodePath, [ohpmJsPath, ...OHPM_ARGS], {
            cwd: projectPath,
            env: { ...process.env, DEVECO_SDK_HOME: sdkPath },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (data: Buffer | string) => {
            stdout += data.toString();
        });
        child.stderr?.on('data', (data: Buffer | string) => {
            stderr += data.toString();
        });

        child.on('close', (code: number | null) => {
            const output = [stdout, stderr].filter(Boolean).join('\n');
            resolve({ exitCode: code ?? -1, output });
        });

        child.on('error', (err: Error) => {
            const output = [stdout, stderr].filter(Boolean).join('\n');
            resolve({ exitCode: -1, output: output + '\n' + err.message });
        });
    });
}

function logOhpmOutput(output: string): void {
    output.split(/\r?\n/).filter(Boolean).forEach((line) => logger.info('[ohpm] %s', line));
}

/**
 * 安装所有依赖（异步，不阻塞事件循环）
 * @param projectPath 项目路径
 * @param sdk DevEco SDK 路径，用于推导 ohpm 路径
 * @returns 是否成功
 */
export async function ohpmInstallAll(projectPath: string, sdk: string): Promise<boolean> {
    try {
        const nodePath = findNodePath(sdk);
        if (!nodePath) {
            logger.error('node 路径不存在');
            return false;
        }
        const ohpmJsPath = findOhpmJsPath(sdk);
        if (!ohpmJsPath) {
            logger.error('ohpm (pm-cli.js) 不存在');
            return false;
        }

        const { exitCode, output } = await runOhpmCommand(nodePath, ohpmJsPath, projectPath, sdk);
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