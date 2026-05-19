/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSON5 from 'json5';

export function findJsonObject(filePath: string): unknown | null {
    if (!fs.existsSync(filePath)) {
        return null;
    }
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        if (!content.trim()) {
            return null;
        }
        return JSON5.parse(content);
    } catch {
        return null;
    }
}

export function isString(value: unknown): value is string {
    return typeof value === 'string';
}

export function toFileUri(filePath: string): string {
    try {
        const absPath = path.resolve(filePath);
        let uriStr = new URL(`file://${absPath}`).toString();

        if (os.platform() === 'win32') {
            const match = uriStr.match(/^file:\/\/\/([A-Za-z]):/);
            if (match) {
                const driveLetter = match[1].toUpperCase();
                const rest = uriStr.substring(`file:///${match[1]}:`.length);
                uriStr = `file:///${driveLetter}%3A${rest}`;
            }
        }
        return uriStr;
    } catch {
        return filePath;
    }
}

export function normalizePath(p: string): string {
    if (!p) {
        return p;
    }
    return p.replace(/\\/g, '/');
}

export function toUnixPath(p: string): string {
    let normalized = path.normalize(p).replace(/\\/g, '/');
    if (os.platform() === 'win32') {
        // 匹配盘符 C: → 转为大写
        const match = normalized.match(/^([A-Za-z]):/);
        if (match) {
            const drive = match[1].toUpperCase();
            normalized = `${drive}:${normalized.substring(2)}`;
        }
    }
    return normalized;
}

export function isSdkValid(sdkPath: string | undefined): boolean {
    if (!sdkPath || typeof sdkPath !== 'string') {
        return false;
    }

    const normalizedSdkPath = normalizePath(sdkPath);

    try {
        if (!fs.existsSync(normalizedSdkPath)) {
            return false;
        }
        const stats = fs.lstatSync(normalizedSdkPath);
        if (!stats.isDirectory()) {
            return false;
        }
    } catch {
        return false;
    }

    const defaultDir = path.join(normalizedSdkPath, 'default');
    const sdkPkgPath = path.join(defaultDir, 'sdk-pkg.json');

    try {
        if (!fs.existsSync(defaultDir)) {
            return false;
        }
        const defaultStats = fs.lstatSync(defaultDir);
        if (!defaultStats.isDirectory()) {
            return false;
        }
    } catch {
        return false;
    }

    try {
        if (!fs.existsSync(sdkPkgPath)) {
            return false;
        }
        const pkgStats = fs.lstatSync(sdkPkgPath);
        if (!pkgStats.isFile()) {
            return false;
        }
    } catch {
        return false;
    }

    return true;
}

export function getOsType(): string {
    const p = process.platform;
    if (p === 'win32') {
        return 'Windows';
    }
    if (p === 'darwin') {
        return 'Mac';
    }
    return 'Linux';
}

/**
 * 获取 build-profile.json5 的路径
 */
export function getBuildProfilePath(profilePath: string): string {
    return path.join(profilePath, 'build-profile.json5');
}
