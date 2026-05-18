/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { getOsType } from '../utils.js';
import { logger } from '../logger.js';

/** 构建结果 */
export interface BuildResult {
    success: boolean;
    output: string;
    exitCode: number;
}

const BUILD_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟

/**
 * 执行构建命令（同步，对应 Java executeBuildCommand）
 * @param projectPath 工程路径
 * @param nodePath node 可执行文件路径
 * @param hvigorPath hvigor 脚本路径（.bat/.cmd 或 .js）
 * @param sdkPath DevEco SDK 路径（DEVECO_SDK_HOME）
 * @param hvigorArgs 传给 hvigor 的参数
 * @param osType 操作系统类型，如 "Windows"、"Linux"、"Mac"
 */
export function executeBuildCommand(
    projectPath: string,
    nodePath: string,
    hvigorPath: string,
    sdkPath: string,
    hvigorArgs: string,
    osType: string,
): BuildResult {
    try {
        const isWindows = osType === 'Windows';
        const env = { ...process.env, DEVECO_SDK_HOME: sdkPath };

        if (isWindows) {
            const isBat = /\.(bat|cmd)$/i.test(hvigorPath);
            let cmd: string;
            if (isBat) {
                cmd = [
                    `$env:DEVECO_SDK_HOME='${sdkPath.replace(/'/g, "''")}';`,
                    `cd '${projectPath.replace(/'/g, "''")}';`,
                    `& '${hvigorPath.replace(/'/g, "''")}' ${hvigorArgs}`,
                ].join(' ');
            } else {
                cmd = [
                    `$env:DEVECO_SDK_HOME='${sdkPath.replace(/'/g, "''")}';`,
                    `cd '${projectPath.replace(/'/g, "''")}';`,
                    `& '${nodePath.replace(/'/g, "''")}' '${hvigorPath.replace(/'/g, "''")}' ${hvigorArgs}`,
                ].join(' ');
            }
            const result = spawnSync('powershell.exe', ['-Command', cmd], {
                cwd: projectPath,
                env,
                encoding: 'utf8',
                timeout: BUILD_TIMEOUT_MS,
                windowsHide: true,
            });
            return normalizeSyncResult(result);
        } else {
            const bashCmd = [
                `export DEVECO_SDK_HOME='${sdkPath.replace(/'/g, "'\\''")}'`,
                `cd '${projectPath.replace(/'/g, "'\\''")}'`,
                `'${nodePath.replace(/'/g, "'\\''")}' '${hvigorPath.replace(/'/g, "'\\''")}' ${hvigorArgs}`,
            ].join(' && ');
            const result = spawnSync('bash', ['-c', bashCmd], {
                cwd: projectPath,
                env,
                encoding: 'utf8',
                timeout: BUILD_TIMEOUT_MS,
            });
            return normalizeSyncResult(result);
        }
    } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        return {
            success: false,
            output: `Build execution exception: ${err.message}`,
            exitCode: -1,
        };
    }
}

function normalizeSyncResult(result: ReturnType<typeof spawnSync>): BuildResult {
    const stdout = (result.stdout ?? '') as string;
    const stderr = (result.stderr ?? '') as string;
    const output = [stdout, stderr].filter(Boolean).join('\n').trim() || '';

    if (result.signal) {
        const timeoutMsg =
            'Build process timeout after 10 minutes. The build may be hanging or taking too long.\n' +
            'Output so far:\n' +
            output;
        return { success: false, output: timeoutMsg, exitCode: -1 };
    }

    const exitCode = result.status ?? -1;
    return {
        success: exitCode === 0,
        output,
        exitCode,
    };
}

function getEnvConfig(sdkPath: string): Record<string, string> {
    const hvigorwPath = path.join(path.dirname(sdkPath), 'tools', 'hvigor', 'bin', 'hvigorw.js');
    return {
        node_path: process.execPath ?? 'node',
        hvigor_path: hvigorwPath,
        sdk_path: sdkPath,
    };
}

function validateConfig(config: Record<string, string>): string | null {
    if (!config.node_path || !fs.existsSync(config.node_path)) {
        return `Node path not found or invalid: ${config.node_path}`;
    }
    if (!config.hvigor_path || !fs.existsSync(config.hvigor_path)) {
        return `Hvigor path not found or invalid: ${config.hvigor_path}`;
    }
    if (!config.sdk_path || !fs.existsSync(config.sdk_path)) {
        return `SDK path not found or invalid: ${config.sdk_path}`;
    }
    return null;
}

const DEFAULT_HVIGOR_ARGS = '--sync -p product=default --analyze=normal --parallel --incremental --no-daemon';

/**
 * 同步工程：校验配置后执行 hvigor 构建（同步）
 * @param projectPath 工程路径
 * @param sdkPath DevEco SDK 路径
 * @returns 是否成功
 */
export function syncProject(projectPath: string, sdkPath: string): boolean {
    try {
        const config = getEnvConfig(sdkPath);
        const validation = validateConfig(config);
        if (validation != null) {
            logger.info(`Config validation failed: ${validation}`);
            return false;
        }
        const nodePath = config.node_path;
        const hvigorPath = config.hvigor_path;
        const osType = getOsType();
        const buildResult = executeBuildCommand(
            projectPath,
            nodePath,
            hvigorPath,
            sdkPath,
            DEFAULT_HVIGOR_ARGS,
            osType,
        );
        return buildResult.success;
    } catch (e) {
        logger.info(`syncProject failed: ${JSON.stringify(e)}`);
        return false;
    }
}
