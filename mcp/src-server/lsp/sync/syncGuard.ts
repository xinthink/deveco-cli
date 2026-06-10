/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger.js';
import { Constants, SYNC_OUTPUT_PATH } from '../parse/Constants.js';
import { findJsonObject } from '../utils.js';

/**
 * mtime 容差（毫秒）。
 * 部分文件系统（FAT32、网络挂载）的 mtime 精度为 2s，引入 1s 容差避免误判。
 */
const MTIME_TOLERANCE_MS = 1000;

/** sync 必要性检测结果 */
export interface SyncCheckResult {
    required: boolean;
    reason: string;
}

interface ModuleEntry {
    name: string;
    srcPath: string;
}

/**
 * 判断 MCP 启动时是否需要执行 sync。
 *
 * 核心逻辑：
 *   取 .hvigor/outputs/sync/output.json 的 mtime 作为 sync 基准时间戳——
 *   该文件每次 sync 必定会被更新，跨平台（Windows / macOS）行为一致。
 *   逐一比对各源 oh-package.json5 的 mtime 是否晚于该基准。
 *
 * @param projectRoot 项目根目录
 * @param forceSync   是否强制 sync（来自环境变量 DEVECO_MCP_FORCE_SYNC）
 */
export function checkSyncRequired(projectRoot: string, forceSync: boolean): SyncCheckResult {
    if (forceSync) {
        logger.info(`[SyncGuard] ${Constants.ENV_FORCE_SYNC}=1, forcing sync`);
        return { required: true, reason: `${Constants.ENV_FORCE_SYNC}=1` };
    }

    // 取 sync 基准时间戳：.hvigor/outputs/sync/output.json 的 mtime
    const baselineFile = path.join(projectRoot, SYNC_OUTPUT_PATH);
    if (!fs.existsSync(baselineFile)) {
        logger.info(`[SyncGuard] Baseline file not found: ${baselineFile}`);
        return { required: true, reason: 'sync baseline file not found: ' + baselineFile };
    }
    const syncBaseline = fs.statSync(baselineFile).mtimeMs;
    logger.info(`[SyncGuard] Sync baseline: ${new Date(syncBaseline).toISOString()} (${baselineFile})`);

    // 解析模块列表
    const modules = parseModules(projectRoot);
    if (modules === null) {
        logger.warn('[SyncGuard] Failed to parse build-profile.json5, falling back to sync');
        return { required: true, reason: 'failed to parse build-profile.json5' };
    }

    // 检查项目级 oh-package.json5
    const rootOhPackage = path.join(projectRoot, Constants.OH_PACKAGE_JSON5);
    const rootResult = compareWithBaseline(rootOhPackage, syncBaseline, 'root');
    if (rootResult.required) {
        logger.info(`[SyncGuard] Root check: ${rootResult.reason}`);
        return rootResult;
    }

    // 检查 build-profile.json5
    const buildProfilePath = path.join(projectRoot, 'build-profile.json5');
    const buildProfileResult = compareWithBaseline(buildProfilePath, syncBaseline, 'build-profile');
    if (buildProfileResult.required) {
        logger.info(`[SyncGuard] Build profile check: ${buildProfileResult.reason}`);
        return buildProfileResult;
    }

    // 逐模块检查
    for (const mod of modules) {
        const srcOhPackage = path.join(projectRoot, mod.srcPath, Constants.OH_PACKAGE_JSON5);
        const modResult = compareWithBaseline(srcOhPackage, syncBaseline, mod.name);
        if (modResult.required) {
            logger.info(`[SyncGuard] Module '${mod.name}' check: ${modResult.reason}`);
            return modResult;
        }
    }

    const reason = `all oh-package.json5 files are up-to-date (sync baseline: ${new Date(syncBaseline).toISOString()})`;
    logger.info(`[SyncGuard] ${reason}`);
    return { required: false, reason };
}

/**
 * 比对单个源文件 mtime 与 sync 基准时间戳。
 * 源文件不存在时跳过（返回 required=false），不视为需要 sync。
 */
function compareWithBaseline(
    srcPath: string,
    syncBaseline: number,
    label: string,
): SyncCheckResult {
    if (!fs.existsSync(srcPath)) {
        return { required: false, reason: `${label}: source not found, skip` };
    }

    const srcMtime = fs.statSync(srcPath).mtimeMs;

    if ((srcMtime - syncBaseline) > MTIME_TOLERANCE_MS) {
        return {
            required: true,
            reason:
                `${label}: source mtime (${new Date(srcMtime).toISOString()}) ` +
                `is newer than sync baseline (${new Date(syncBaseline).toISOString()})`,
        };
    }

    return { required: false, reason: `${label}: up-to-date` };
}

function parseModules(projectRoot: string): ModuleEntry[] | null {
    const buildProfilePath = path.join(projectRoot, 'build-profile.json5');
    try {
        const obj = findJsonObject(buildProfilePath);
        if (typeof obj !== 'object' || obj === null) {
            return null;
        }
        const modules = (obj as Record<string, unknown>).modules;
        if (!Array.isArray(modules)) {
            return null;
        }
        return modules.filter((m): m is ModuleEntry => {
            if (typeof m !== 'object' || m === null) {
                return false;
            }
            const rec = m as Record<string, unknown>;
            return typeof rec.name === 'string' && typeof rec.srcPath === 'string';
        });
    } catch {
        return null;
    }
}
