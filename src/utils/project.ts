/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs';
import * as path from 'path';
import json5 from 'json5';
import { CommonUtils } from './common-utils.js';

export interface ProductNode {
  name: string;
}

export interface BuildModeNode {
  name: string;
}

export interface AppNode {
  products: ProductNode[];
  buildModeSet: BuildModeNode[];
}

export interface ModuleNode {
  name: string;
  srcPath: string;
}

export interface ProjectProfile {
  app: AppNode;
  modules: ModuleNode[];
}

export interface TargetNode {
  name: string;
}

export interface AbilityNode {
  name: string;
}

export interface ModuleProfile {
  targets: TargetNode[];
}

export class Project {
  public rootDir: string;
  public profile: ProjectProfile;

  private constructor(rootDir: string, profile: ProjectProfile) {
    this.rootDir = rootDir;
    this.profile = profile;
  }

  public static discover(startDir: string): Project {
    let currentDir = startDir;

    while (true) {
      const profile = Project.tryLoadProjectProfile(currentDir);
      if (profile) {
        return new Project(currentDir, profile);
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    throw new Error(
      'Not in a valid project directory (project-level build-profile.json5 not found)'
    );
  }

  private static tryLoadProjectProfile(dir: string): ProjectProfile | null {
    const profilePath = path.join(dir, 'build-profile.json5');
    if (!fs.existsSync(profilePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(profilePath, 'utf-8');
      const profile = json5.parse(content) as ProjectProfile;
      return profile.app ? profile : null;
    } catch (e) {
      console.error(`Error parsing ${profilePath}:`, e);
      return null;
    }
  }

  public getModuleType(moduleName: string): string {
    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      throw new Error(
        `Module '${moduleName}' not found in project build-profile.json5.`
      );
    }

    const moduleDir = CommonUtils.resolvePathWithinRoot(this.rootDir, moduleNode.srcPath);
    const moduleJsonPath = path.join(moduleDir, 'src', 'main', 'module.json5');

    if (!fs.existsSync(moduleJsonPath)) {
      // Default to 'entry' if module.json5 doesn't exist or isn't found
      return 'entry';
    }

    try {
      const content = fs.readFileSync(moduleJsonPath, 'utf-8');
      const moduleInfo = json5.parse(content) as {
        module?: { type?: string };
      };
      return moduleInfo?.module?.type || 'entry';
    } catch (e) {
      console.warn(`Warning: Failed to parse ${moduleJsonPath}:`, e);
      return 'entry';
    }
  }

  public getModuleProfile(moduleName: string): ModuleProfile {
    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      throw new Error(
        `Module '${moduleName}' not found in project build-profile.json5.`
      );
    }

    const moduleDir = CommonUtils.resolvePathWithinRoot(this.rootDir, moduleNode.srcPath);
    const profilePath = path.join(moduleDir, 'build-profile.json5');

    if (!fs.existsSync(profilePath)) {
      throw new Error(
        `Build profile for module '${moduleName}' not found at ${profilePath}`
      );
    }

    const content = fs.readFileSync(profilePath, 'utf-8');
    const profile = json5.parse(content) as ModuleProfile;
    return profile;
  }

  public getBundleName(): string {
    const appJson5Path = path.join(this.rootDir, 'AppScope', 'app.json5');
    if (fs.existsSync(appJson5Path)) {
      try {
        const content = fs.readFileSync(appJson5Path, 'utf-8');
        const json = json5.parse(content) as {
          app?: { bundleName?: string };
        };
        if (json?.app?.bundleName) {
          return json.app.bundleName;
        }
      } catch (e) {
        console.warn(`Warning: Failed to parse ${appJson5Path}:`, e);
      }
    }
    throw new Error('Could not find bundleName in AppScope/app.json5');
  }

  public getMainAbility(moduleName: string, ability?: string): string {
    if (ability) {
      return ability;
    }

    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      return 'EntryAbility';
    }

    const moduleDir = CommonUtils.resolvePathWithinRoot(this.rootDir, moduleNode.srcPath);
    const moduleJsonPath = path.join(moduleDir, 'src', 'main', 'module.json5');

    if (!fs.existsSync(moduleJsonPath)) {
      return 'EntryAbility';
    }

    try {
      const content = fs.readFileSync(moduleJsonPath, 'utf-8');
      const json = json5.parse(content) as {
        module?: { abilities?: AbilityNode[] };
      };
      const abilities = json?.module?.abilities || [];

      if (abilities.length === 0) {
        return 'EntryAbility';
      }

      const entryAbility = abilities.find((a) => a.name === 'EntryAbility');
      return entryAbility ? entryAbility.name : abilities[0].name;
    } catch (e) {
      console.warn(`Warning: Failed to parse ${moduleJsonPath}:`, e);
      return 'EntryAbility';
    }
  }

  public getModuleDependencies(moduleName: string): string[] {
    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      return [];
    }

    const moduleDir = CommonUtils.resolvePathWithinRoot(this.rootDir, moduleNode.srcPath);
    const pkgPath = path.join(moduleDir, 'oh-package.json5');
    if (!fs.existsSync(pkgPath)) {
      return [];
    }

    const deps: string[] = [];

    try {
      const content = fs.readFileSync(pkgPath, 'utf-8');
      const pkg = json5.parse(content) as { dependencies?: Record<string, string> };
      const dependencies = pkg?.dependencies || {};

      for (const value of Object.values(dependencies)) {
        if (typeof value !== 'string') {
          continue;
        }

        let relativePath = value;
        const isLocal = relativePath.startsWith('file:') || relativePath.startsWith('.') || relativePath.startsWith('..');
        if (!isLocal) {
          continue;
        }

        if (relativePath.startsWith('file:')) {
          relativePath = relativePath.substring(5);
        }

        const depDir = path.resolve(this.rootDir, moduleNode.srcPath, relativePath);
        const depModule = this.profile.modules.find(
          (m) => path.resolve(this.rootDir, m.srcPath) === depDir
        );

        if (depModule) {
          deps.push(depModule.name);
        }
      }
    } catch {
      // Ignore unparseable oh-package.json5
    }
    return deps;
  }

  public collectNonHarDependentModuleList(module: string) {
    const dependentModules: string[] = [];
    const moduleQueue: string[] = [];
    const processedModules = new Set<string>();

    moduleQueue.push(module);
    processedModules.add(module);

    while (moduleQueue.length > 0) {
      const currentModule = moduleQueue.shift()!;
      const type = this.getModuleType(currentModule);
      if (type !== 'har') {
        dependentModules.push(currentModule);
      } 
      const deps = this.getModuleDependencies(currentModule);
      for (const depModule of deps) {
        if (!processedModules.has(depModule)) {
          moduleQueue.push(depModule);
          processedModules.add(depModule);
        }
      }
    }
    return dependentModules;
  }

  public findArtifactPath(
    moduleName: string,
    target: string,
    isEmulator: boolean,
    product = 'default'
  ): string {
    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      throw new Error(`Module '${moduleName}' not found`);
    }

    const moduleType = this.getModuleType(moduleName);
    const isShared = moduleType === 'shared';
    const metadataKey = isShared ? 'hspName' : 'hapName';

    const metadataPath = this.buildOutputPath(moduleNode.srcPath, product, [
      'intermediates',
      isShared ? 'hsp_metadata' : 'hap_metadata',
      target,
      'output_metadata.json',
    ]);

    if (!fs.existsSync(metadataPath)) {
      throw new Error(
        `Build metadata not found for module '${moduleName}' at ${metadataPath}. Please build the project first.`
      );
    }

    const { packageName, isSigned } = this.parseOutputMetadata(
      metadataPath,
      metadataKey
    );

    if (!isEmulator && !isSigned) {
      throw new Error(
        `Target device is a real device, but the artifact for '${moduleName}' is not signed. Real devices cannot install unsigned packages.`
      );
    }

    const packagePath = this.buildOutputPath(moduleNode.srcPath, product, [
      'outputs',
      target,
      packageName,
    ]);

    if (!fs.existsSync(packagePath)) {
      throw new Error(`Generated package file does not exist: ${packagePath}`);
    }

    return packagePath;
  }

  private buildOutputPath(
    srcPath: string,
    product: string,
    segments: string[]
  ): string {
    const srcDir = CommonUtils.resolvePathWithinRoot(this.rootDir, srcPath);
    const finalPath = path.resolve(srcDir, 'build', product, ...segments);
    return CommonUtils.ensurePathWithinRoot(this.rootDir, finalPath);
  }

  private parseOutputMetadata(
    metadataPath: string,
    metadataKey: string
  ): { packageName: string; isSigned: boolean } {
    const content = fs.readFileSync(metadataPath, 'utf-8');
    const parsed = json5.parse(content) as
      | Record<string, string | boolean>[]
      | Record<string, string | boolean>;

    let packageName: string | undefined;
    let isSigned = false;

    if (Array.isArray(parsed)) {
      const first = parsed[0];
      if (first) {
        packageName = first[metadataKey] as string | undefined;
        isSigned = first.isSigned === true;
      }
    } else if (parsed && typeof parsed === 'object') {
      packageName = parsed[metadataKey] as string | undefined;
      isSigned = parsed.isSigned === true;
    }

    if (!packageName) {
      throw new Error(
        `Could not find ${metadataKey} in output_metadata.json at ${metadataPath}`
      );
    }

    return { packageName, isSigned };
  }
}
