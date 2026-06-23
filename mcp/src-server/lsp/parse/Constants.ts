/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export const Constants = {
    HVIGOR_CACHE: '.hvigor',
    DEPENDENCY: 'dependencyMap',
    JSON5: '.json5',
    KEY_DEPENDENCY: 'dependencies',
    KEY_DYNAMIC_DEPENDENCY: 'dynamicDependencies',
    KEY_DEV_DEPENDENCY: 'devDependencies',
    OH_MODULES_PATH: 'oh_modules',
    OHPM_PATH: '.ohpm',
    LOCK_JSON5_FILE: 'lock.json5',
    OH_PACKAGE_JSON5: 'oh-package.json5',
    /** hvigor sync 产物文件，每次 sync 必定更新，用作 sync 基准时间戳来源 */
    SYNC_OUTPUT_FILE: 'output.json',
    /** 强制 sync 的环境变量名 */
    ENV_FORCE_SYNC: 'DEVECO_MCP_FORCE_SYNC',
};

export const DEPENDENCY_MAP_PATH = `${Constants.HVIGOR_CACHE}/${Constants.DEPENDENCY}`;
export const DEPENDENCY_MAP_JSON5 = `${Constants.DEPENDENCY}${Constants.JSON5}`;
export const SYNC_OUTPUT_PATH = `${Constants.HVIGOR_CACHE}/outputs/sync/${Constants.SYNC_OUTPUT_FILE}`;
