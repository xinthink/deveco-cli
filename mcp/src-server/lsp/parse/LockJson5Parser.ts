/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import JSON5 from 'json5';
import { DependencyInfo } from './DependencyInfo.js';
import { Constants } from './Constants.js';
import { logger } from '../logger.js';
import { isRecord } from '../common/typeGuards.js';

export class LockJson5Parser {
    public projectPath: string;
    private static readonly FILE_DEPENDENCY_PREFIX = 'file:';
    private readonly fileNameForOhpm = /[.](?:har|tgz|tar.gz|tar)$/;

    public finalDependencies: DependencyInfo[] = [];
    public finalDevDependencies: DependencyInfo[] = [];
    public finalDynamicDependencies: DependencyInfo[] = [];
    private storePathMap: Map<string, string> = new Map();

    constructor(projectPath: string = '') {
        this.projectPath = projectPath;
    }

    public parseDependencies(moduleModelName: string): boolean {
        const lockFilePath = this.getLockFilePath();

        const lockFileJsonObject = this.readLockFile(lockFilePath);
        if (!lockFileJsonObject) {
            return false;
        }

        const validationResult = this.validateLockFile(lockFileJsonObject);
        if (!validationResult.valid) {
            return false;
        }

        this.extractDependencies(validationResult.modules, validationResult.packages, moduleModelName);
        return true;
    }

    private getLockFilePath(): string {
        return path.join(
            this.projectPath,
            Constants.OH_MODULES_PATH,
            Constants.OHPM_PATH,
            Constants.LOCK_JSON5_FILE,
        );
    }

    private readLockFile(lockFilePath: string): unknown | null {
        if (!fs.existsSync(lockFilePath)) {
            logger.error('lock file does not exist');
            this.clearDependencies();
            return null;
        }

        try {
            const lockFileContent = fs.readFileSync(lockFilePath, 'utf8');
            const lockFileJsonObject = JSON5.parse(lockFileContent);

            if (!lockFileJsonObject) {
                logger.error('lockFileJsonObject is null');
                this.clearDependencies();
                return null;
            }

            return lockFileJsonObject;
        } catch (e) {
            logger.error('Error parsing lock.json5:', e);
            this.clearDependencies();
            return null;
        }
    }

    private validateLockFile(lockFileJsonObject: unknown): { valid: boolean; modules?: unknown; packages?: unknown } {
        if (!isRecord(lockFileJsonObject)) {
            logger.error('lockFileJsonObject is not a valid object');
            this.clearDependencies();
            return { valid: false };
        }

        const modulesJsonObject = lockFileJsonObject.modules;
        if (!modulesJsonObject) {
            logger.error('modulesJsonObject is null');
            this.clearDependencies();
            return { valid: false };
        }

        const packagesJsonObject = lockFileJsonObject.packages;
        if (!packagesJsonObject) {
            logger.error('packagesJsonObject is null');
            this.clearDependencies();
            return { valid: false };
        }

        return { valid: true, modules: modulesJsonObject, packages: packagesJsonObject };
    }

    private extractDependencies(modulesJsonObject: unknown, packagesJsonObject: unknown, moduleName: string): void {
        this.storePathMap = this.parseStorePathMap(packagesJsonObject);
        this.finalDependencies = this.getDependencyList(
            modulesJsonObject,
            Constants.KEY_DEPENDENCY,
            moduleName,
        );
        this.finalDevDependencies = this.getDependencyList(
            modulesJsonObject,
            Constants.KEY_DEV_DEPENDENCY,
            moduleName,
        );
        this.finalDynamicDependencies = this.getDependencyList(
            modulesJsonObject,
            Constants.KEY_DYNAMIC_DEPENDENCY,
            moduleName,
        );
    }

    public parseStorePathMap(packagesJsonObject: unknown): Map<string, string> {
        const storePathMap = new Map<string, string>();
        if (!isRecord(packagesJsonObject)) {
            return storePathMap;
        }
        for (const [key, value] of Object.entries(packagesJsonObject)) {
            if (!isRecord(value)) {
                logger.error(`${key} value is not json object`);
                continue;
            }
            if (typeof value.storePath === 'string') {
                storePathMap.set(key, value.storePath);
            }
        }
        return storePathMap;
    }

    public getDependencyList(modulesJsonObject: unknown, dependencyType: string, moduleName: string): DependencyInfo[] {
        if (!isRecord(modulesJsonObject)) {
            return [];
        }
        for (const [relativeModulePath, value] of Object.entries(modulesJsonObject)) {
            if (isRecord(value)) {
                const name = typeof value.name === 'string' ? value.name : '';
                if (('.' === moduleName && name === '') || name === moduleName) {
                    return this.getFinalDependencyList(modulesJsonObject, dependencyType, relativeModulePath);
                }
            }
        }
        return [];
    }

    public getFinalDependencyList(
        modulesJsonObject: Record<string, unknown>,
        dependencyType: string,
        relativeModulePath: string,
    ): DependencyInfo[] {
        const moduleJsonObject = modulesJsonObject[relativeModulePath];
        if (!isRecord(moduleJsonObject)) {
            logger.error('moduleJsonObject is null');
            return [];
        }

        const dependencies: DependencyInfo[] = [];
        const dependenciesObject = moduleJsonObject[dependencyType];
        if (!isRecord(dependenciesObject)) {
            return [];
        }

        for (const [key, value] of Object.entries(dependenciesObject)) {
            if (!isRecord(value)) {
                continue;
            }

            const specifier = typeof value.specifier === 'string' ? value.specifier : '';
            const version = typeof value.version === 'string' ? value.version : '';
            const dependencyInfo = new DependencyInfo();
            dependencyInfo.name = key;
            dependencyInfo.version = version.startsWith(LockJson5Parser.FILE_DEPENDENCY_PREFIX)
                ? version.substring(LockJson5Parser.FILE_DEPENDENCY_PREFIX.length)
                : version;

            this.parseDependencyPath(dependencyInfo, relativeModulePath, key, specifier, version);

            const packageName = `${key}@${version}`;
            if (this.storePathMap.has(packageName)) {
                dependencyInfo.storePath = this.storePathMap.get(packageName) || '';
            }

            dependencies.push(dependencyInfo);
        }
        return dependencies;
    }

    private parseDependencyPath(
        dependencyInfo: DependencyInfo,
        relativeModulePath: string,
        dependencyKey: string,
        specifier: string,
        version: string,
    ): void {
        const dependencyPath = path.normalize(
            path.join(this.projectPath, relativeModulePath, Constants.OH_MODULES_PATH, dependencyKey),
        );

        try {
            let filePathStr = version;
            if (version.startsWith(LockJson5Parser.FILE_DEPENDENCY_PREFIX)) {
                filePathStr = version.substring(LockJson5Parser.FILE_DEPENDENCY_PREFIX.length);
            }

            let filePath = filePathStr;
            if (!path.isAbsolute(filePath)) {
                filePath = path.join(this.projectPath, filePathStr);
            }

            if (!fs.existsSync(filePath)) {
                dependencyInfo.dependencyPath = dependencyPath;
                return;
            }

            dependencyInfo.path = specifier;
            if (this.fileNameForOhpm.test(version)) {
                dependencyInfo.dependencyPath = dependencyPath;
                return;
            }

            dependencyInfo.dependencyPath = filePath;
        } catch (e) {
            logger.error('Invalid dependency path in lock.json5', e);
        }
    }

    public clearDependencies(): void {
        this.finalDependencies = [];
        this.finalDevDependencies = [];
        this.finalDynamicDependencies = [];
    }
}
