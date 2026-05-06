/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs';
import * as path from 'path';
import json5 from 'json5';

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

    const moduleDir = path.join(this.rootDir, moduleNode.srcPath);
    const moduleJsonPath = path.join(moduleDir, 'src', 'main', 'module.json5');

    if (!fs.existsSync(moduleJsonPath)) {
      // Default to 'entry' if module.json5 doesn't exist or isn't found
      return 'entry';
    }

    try {
      const content = fs.readFileSync(moduleJsonPath, 'utf-8');
      const moduleInfo = json5.parse(content);
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

    const moduleDir = path.join(this.rootDir, moduleNode.srcPath);
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
}
