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
      'Not in a valid project directory (project-level build-profile.json5 not found).'
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
        `Module '${moduleName}' not found in project-level build-profile.json5.`
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
        `Module '${moduleName}' not found in project-level build-profile.json5.`
      );
    }

    const moduleDir = CommonUtils.resolvePathWithinRoot(this.rootDir, moduleNode.srcPath);
    const profilePath = path.join(moduleDir, 'build-profile.json5');

    if (!fs.existsSync(profilePath)) {
      throw new Error(
        `Build profile for module '${moduleName}' not found at ${profilePath}.`
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
    throw new Error('Could not find bundleName in AppScope/app.json5.');
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

  public validateProduct(product: string): void {
    if (!/^[\da-zA-Z_-]+$/.test(product)) {
      throw new Error(
        `Invalid product name '${product}'. Product names must only contain letters, digits, underscores, and hyphens.`
      );
    }
    const productExists = this.profile.app.products?.some((p) => p.name === product);
    if (!productExists) {
      const availableProducts = this.profile.app.products?.map((p) => p.name).join(', ') || 'none';
      throw new Error(
        `Product '${product}' not found in project configuration. Available products: ${availableProducts}`
      );
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
        const combinedRelativePath = path.join(moduleNode.srcPath, relativePath);
        const depDir = CommonUtils.resolvePathWithinRoot(this.rootDir, combinedRelativePath);
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

  private resolveModuleMetadata(
    moduleName: string,
    target: string,
    product: string
  ): {
    moduleNode: { srcPath: string };
    isShared: boolean;
    metadataPath: string;
    metadata: ReturnType<Project['parseOutputMetadata']>;
  } {
    this.validateProduct(product);

    const moduleNode = this.profile.modules.find((m) => m.name === moduleName);
    if (!moduleNode) {
      throw new Error(`Module '${moduleName}' not found`);
    }

    const isShared = this.getModuleType(moduleName) === 'shared';
    const metadataKey = isShared ? 'hspName' : 'hapName';

    const metadataPath = this.buildOutputPath(moduleNode.srcPath, product, [
      'intermediates',
      isShared ? 'hsp_metadata' : 'hap_metadata',
      target,
      'output_metadata.json',
    ]);

    if (!fs.existsSync(metadataPath)) {
      throw new Error(
        `Build metadata not found for module '${moduleName}' at ${metadataPath}. Build the project first.`
      );
    }

    const metadata = this.parseOutputMetadata(metadataPath, metadataKey);

    return { moduleNode, isShared, metadataPath, metadata };
  }

  public findArtifactPath(
    moduleName: string,
    target: string,
    isEmulator: boolean,
    product = 'default'
  ): string {
    const { moduleNode, isShared, metadata } = this.resolveModuleMetadata(
      moduleName,
      target,
      product
    );
    const { packageName, isSigned } = metadata;
    let finalPackageName = packageName;

    // 优先获取签名包
    if (!isSigned) {
      const signedHapName = this.getSignedHapName(packageName, moduleNode.srcPath, product, target);
      if (signedHapName) {
        finalPackageName = signedHapName;
      }
    }

    const signedSuffix = isShared ? '-signed.hsp' : '-signed.hap';
    if (!isEmulator && !finalPackageName.endsWith(signedSuffix)) {
      throw new Error(
        `Target device is a real device, but the artifact for '${moduleName}' is not signed. Real devices cannot install unsigned packages.`
      );
    }

    const packagePath = this.buildOutputPath(moduleNode.srcPath, product, [
      'outputs',
      target,
      finalPackageName,
    ]);

    if (!fs.existsSync(packagePath)) {
      throw new Error(`Generated package file not found in ${packagePath}.`);
    }

    return packagePath;
  }

  public findRemoteHspPaths(
    moduleName: string,
    target: string,
    product = 'default'
  ): string[] {
    const { moduleNode, metadata } = this.resolveModuleMetadata(
      moduleName,
      target,
      product
    );

    const result: string[] = [];
    const seen = new Set<string>();
    for (const { hspPath } of metadata.dependRemoteHsps) {
      if (seen.has(hspPath)) {continue}
      seen.add(hspPath);

      const resolvedPath = path.isAbsolute(hspPath)
        ? hspPath
        : this.buildOutputPath(moduleNode.srcPath, product, ['outputs', target, hspPath]);

      if (!fs.existsSync(resolvedPath)) {
        throw new Error(
          `Remote HSP dependency not found: ${resolvedPath}`
        );
      }
      result.push(resolvedPath);
    }

    return result;
  }

  private getSignedHapName(
    packageName: string,
    srcPath: string,
    product: string,
    target: string
  ): string | null {
    let signedHapName: string | null = null;
    if (packageName.endsWith('-unsigned.hap')) {
      signedHapName = packageName.replace('-unsigned.hap', '-signed.hap');
    } else if (packageName.endsWith('-unsigned.hsp')) {
      signedHapName = packageName.replace('-unsigned.hsp', '-signed.hsp');
    }

    if (!signedHapName) {
      return null;
    }

    const signedPackagePath = this.buildOutputPath(srcPath, product, [
      'outputs',
      target,
      signedHapName,
    ]);

    if (fs.existsSync(signedPackagePath)) {
      return signedHapName;
    }
    return null;
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

  private collectRemoteHsps(items: Record<string, unknown>[]): { hspName: string; hspPath: string }[] {
    return items.flatMap((item) => {
      const deps = item.dependRemoteHsps as { hspName?: string; hspPath?: string }[] | undefined;
      if (!Array.isArray(deps)) {
        return [];
      }
      return deps
        .filter((dep): dep is { hspName: string; hspPath: string } => Boolean(dep.hspName && dep.hspPath))
        .map((dep) => ({ hspName: dep.hspName, hspPath: dep.hspPath }));
    });
  }

  private parseOutputMetadata(
    metadataPath: string,
    metadataKey: string
  ): {
    packageName: string;
    isSigned: boolean;
    dependRemoteHsps: { hspName: string; hspPath: string }[];
  } {
    const content = fs.readFileSync(metadataPath, 'utf-8');
    const parsed = json5.parse(content) as Record<string, unknown>[] | Record<string, unknown>;

    let packageName: string | undefined;
    let isSigned = false;

    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      if (!packageName) {
        packageName = item[metadataKey] as string | undefined;
      }
      if (!isSigned) {
        isSigned = item.isSigned === true;
      }
    }

    if (!packageName) {
      throw new Error(
        `Could not find ${metadataKey} in output_metadata.json at ${metadataPath}`
      );
    }

    this.validatePackageName(packageName);

    const dependRemoteHsps = this.collectRemoteHsps(items);

    return { packageName, isSigned, dependRemoteHsps };
  }

private validatePackageName(packageName: string): void {
    const basename = path.basename(packageName);
    
    if (basename !== packageName) {
      throw new Error(
        `Invalid traversal name: '${packageName}'. It must contain path characters.`
      );
    }
    
    if (!basename.endsWith('.hap') && !basename.endsWith('.hsp')) {
      throw new Error(
        `Invalid package name '${basename}'.It must be a .hap or .hsp file.`
      );
    }
  }
}
