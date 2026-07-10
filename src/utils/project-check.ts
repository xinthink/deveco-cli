/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import json5 from 'json5';
import { debugLog } from './logger.js';
import { ProjectConstants } from '../config/constants.js';

/**
 * mtime 容差（毫秒）。部分文件系统（FAT32、网络挂载）的 mtime 精度为 2s，引入 1s 容差避免误判。
 */
const MTIME_TOLERANCE_MS = 1000;

/** sync 必要性检查结果 */
export interface SyncCheckResult {
    required: boolean;
    reason: string;
}

interface ModuleEntry {
    name: string;
    srcPath: string;
}

/**
 * 判断是否需要执行 hvigor sync
 *
 * 核心逻辑：
 *   取 .hvigor/outputs/sync/output.json 的 mtime 作为 sync 基准时间戳
 *   该文件每次 sync 必定会被更新，跨平台（Windows / macOS）行为一致
 *   逐一比对各源 oh-package.json5 的 mtime 是否晚于该基准
 *
 * @param projectRoot 项目根目录
 */
export function checkSyncRequired(projectRoot: string): SyncCheckResult {
    debugLog(`[ProjectCheck] Checking sync required at project root: ${projectRoot}`);

    // 取 sync 基准时间戳：.hvigor/outputs/sync/output.json 的 mtime
    const baselineFile = path.join(projectRoot, ProjectConstants.SYNC_OUTPUT_PATH);
    if (!fs.existsSync(baselineFile)) {
        const result = { required: true, reason: `sync baseline file not found: ${baselineFile}` };
        debugLog(`[ProjectCheck] ${result.reason}`);
        return result;
    }
    const syncBaseline = fs.statSync(baselineFile).mtimeMs;
    debugLog(`[ProjectCheck] Sync baseline: ${new Date(syncBaseline).toISOString()} (${baselineFile})`);

    // 解析模块列表
    const modules = parseModules(projectRoot);
    if (modules === null) {
        const result = { required: true, reason: 'failed to parse build-profile.json5' };
        debugLog(`[ProjectCheck] ${result.reason}`);
        return result;
    }

    // 检查项目级 oh-package.json5
    const rootOhPackage = path.join(projectRoot, ProjectConstants.OH_PACKAGE_JSON5);
    const rootResult = compareWithBaseline(rootOhPackage, syncBaseline, 'root');
    if (rootResult.required) {
        debugLog(`[ProjectCheck] Root check: ${rootResult.reason}`);
        return rootResult;
    }

    // 检查 build-profile.json5
    const buildProfilePath = path.join(projectRoot, ProjectConstants.BUILD_PROFILE_JSON5);
    const buildProfileResult = compareWithBaseline(buildProfilePath, syncBaseline, 'build-profile');
    if (buildProfileResult.required) {
        debugLog(`[ProjectCheck] Build profile check: ${buildProfileResult.reason}`);
        return buildProfileResult;
    }

    // 逐模块检查
    for (const mod of modules) {
        // 检查模块的 oh-package.json5
        const srcOhPackage = path.join(projectRoot, mod.srcPath, ProjectConstants.OH_PACKAGE_JSON5);
        const modResult = compareWithBaseline(srcOhPackage, syncBaseline, mod.name);
        if (modResult.required) {
            debugLog(`[ProjectCheck] Module '${mod.name}' check: ${modResult.reason}`);
            return modResult;
        }

        // 检查模块的 build-profile.json5
        const modBuildProfile = path.join(projectRoot, mod.srcPath, ProjectConstants.BUILD_PROFILE_JSON5);
        const modBuildProfileResult = compareWithBaseline(modBuildProfile, syncBaseline, mod.name);
        if (modBuildProfileResult.required) {
            debugLog(`[ProjectCheck] Module '${mod.name}' build-profile check: ${modBuildProfileResult.reason}`);
            return modBuildProfileResult;
        }
    }

    const reason = `all configuration files are up-to-date (sync baseline: ${new Date(syncBaseline).toISOString()})`;
    debugLog(`[ProjectCheck] ${reason}`);
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
    const buildProfilePath = path.join(projectRoot, ProjectConstants.BUILD_PROFILE_JSON5);
    try {
        const content = fs.readFileSync(buildProfilePath, 'utf-8');
        if (!content.trim()) {
            return null;
        }
        const obj = json5.parse(content);
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
