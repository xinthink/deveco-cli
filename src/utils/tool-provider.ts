/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs, { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import regedit from 'regedit';
import { join } from 'path';

interface RegeditResult {
  [key: string]: {
    values?: {
      [valueName: string]: {
        value: string | number;
        type: string;
      };
    };
    keys?: string[];
  };
}

// Promisify regedit functions for easier async/await usage
const regList = (keys: string[]): Promise<RegeditResult> => {
  return new Promise((resolve, reject) => {
    regedit.list(keys, (err, result) => {
      if (err) {
        reject(err);
      } else {
        resolve(result as unknown as RegeditResult);
      }
    });
  });
};

export class ToolProvider {
  public devecoStudioPath: string;
  public nodePath: string;
  public ohpmJsPath: string;
  public hvigorJsPath: string;
  public javaPath: string;
  public sdkPath: string;
  public hdcPath: string;
  public emulatorPath: string;
  public emulatorLauncherPath: String | undefined;

  private constructor(
    devecoStudioPath: string,
    nodePath: string,
    ohpmJsPath: string,
    hvigorJsPath: string,
    javaPath: string,
    sdkPath: string,
    hdcPath: string,
    emulatorPath: string,
    emulatorLauncherPath: String | undefined
  ) {
    this.devecoStudioPath = devecoStudioPath;
    this.nodePath = nodePath;
    this.ohpmJsPath = ohpmJsPath;
    this.hvigorJsPath = hvigorJsPath;
    this.javaPath = javaPath;
    this.sdkPath = sdkPath;
    this.hdcPath = hdcPath;
    this.emulatorPath = emulatorPath;
    this.emulatorLauncherPath = emulatorLauncherPath;
  }

  public static async new(): Promise<ToolProvider> {
    const devecoStudioPath = await ToolProvider.findDevEcoStudio();
    const {
      nodePath,
      ohpmJsPath,
      hvigorJsPath,
      javaPath,
      sdkPath,
      hdcPath,
      emulatorPath,
    } = ToolProvider.resolveTools(devecoStudioPath);
    const emulatorLauncherPath = await ToolProvider.getEmulatorExe();
    return new ToolProvider(
      devecoStudioPath,
      nodePath,
      ohpmJsPath,
      hvigorJsPath,
      javaPath,
      sdkPath,
      hdcPath,
      emulatorPath,
      emulatorLauncherPath ?? undefined
    );
  }

  private static async findDevEcoStudio(): Promise<string> {
    const platform = os.platform();

    if (platform === 'win32') {
      return await ToolProvider.findDevEcoStudioWindows();
    } else if (platform === 'darwin') {
      return ToolProvider.findDevEcoStudioMac();
    } else {
      throw new Error(
        'Linux is not fully supported yet for automatic DevEco Studio detection'
      );
    }
  }

  private static async findDevEcoStudioWindows(): Promise<string> {
    // 1. Try registry lookup first (highest priority)
    const uninstallPath = await ToolProvider.findDevEcoStudioFromUninstall();
    if (uninstallPath) {
      return uninstallPath;
    }

    const wow64Path = await ToolProvider.findDevEcoStudioFromWow64Key();
    if (wow64Path) {
      return wow64Path;
    }

    // 2. Check default paths as fallback
    return ToolProvider.findDevEcoStudioFromDefaultPaths();
  }

  private static async findDevEcoStudioFromUninstall(): Promise<
    string | undefined
  > {
    try {
      // Standard uninstall registry key
      const uninstallKey =
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DevEco Studio';
      const result = await regList([uninstallKey]);
      const installPath = result[uninstallKey]?.values?.InstallLocation
        ?.value as string | undefined;
      if (ToolProvider.isExistingDirectory(installPath)) {
        return installPath;
      }
    } catch {
      // Ignore errors
    }
    return undefined;
  }

  private static async findDevEcoStudioFromWow64Key(): Promise<
    string | undefined
  > {
    try {
      // WOW6432Node specific registry key
      const huaweiKey = 'HKLM\\SOFTWARE\\WOW6432Node\\Huawei\\DevEco Studio';
      const result = await regList([huaweiKey]);

      const versionKeys = result[huaweiKey]?.keys ?? [];
      if (versionKeys.length === 0) {
        return undefined;
      }

      // Find all subkeys (version numbers) and look up their default values
      const subkeys = versionKeys.map((k: string) => `${huaweiKey}\\${k}`);
      const subkeysResult = await regList(subkeys);

      for (const subkey of subkeys) {
        // The default value key is represented by an empty string ''
        const installPath = subkeysResult[subkey]?.values?.[''].value as
          | string
          | undefined;
        if (ToolProvider.isExistingDirectory(installPath)) {
          return installPath;
        }
      }
    } catch {
      // Ignore errors
    }
    return undefined;
  }

  private static isExistingDirectory(p: string | undefined): p is string {
    return !!p && fs.existsSync(p) && fs.statSync(p).isDirectory();
  }

  private static findDevEcoStudioFromDefaultPaths(): string {
    const defaultPaths = [
      path.join('C:', 'Program Files', 'Huawei', 'DevEco Studio'),
    ];

    for (const p of defaultPaths) {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return p;
      }
    }

    throw new Error(
      'DevEco Studio installation not found in registry or default locations'
    );
  }

  private static findDevEcoStudioMac(): string {
    const homeDir = os.homedir();
    const pathsToCheck = [
      path.join(homeDir, 'Applications', 'DevEco-Studio.app'),
      path.join('/Applications', 'DevEco-Studio.app'),
    ];

    for (const p of pathsToCheck) {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        return p;
      }
    }

    throw new Error(
      'DevEco Studio not found in /Applications or ~/Applications'
    );
  }

  private static resolveTools(devecoStudioPath: string): {
    nodePath: string;
    ohpmJsPath: string;
    hvigorJsPath: string;
    javaPath: string;
    sdkPath: string;
    hdcPath: string;
    emulatorPath: string;
  } {
    const platform = os.platform();
    let nodePath: string;
    let ohpmJsPath: string;
    let hvigorJsPath: string;
    let javaPath: string;
    let sdkPath: string;

    if (platform === 'win32') {
      const toolsDir = path.join(devecoStudioPath, 'tools');
      nodePath = path.join(toolsDir, 'node', 'node.exe');
      ohpmJsPath = path.join(toolsDir, 'ohpm', 'bin', 'pm-cli.js');
      hvigorJsPath = path.join(toolsDir, 'hvigor', 'bin', 'hvigorw.js');
      javaPath = path.join(devecoStudioPath, 'jbr', 'bin', 'java.exe');
      sdkPath = path.join(devecoStudioPath, 'sdk');
    } else if (platform === 'darwin') {
      const toolsDir = path.join(devecoStudioPath, 'Contents', 'tools');
      nodePath = path.join(toolsDir, 'node', 'bin', 'node');
      ohpmJsPath = path.join(toolsDir, 'ohpm', 'bin', 'pm-cli.js');
      hvigorJsPath = path.join(toolsDir, 'hvigor', 'bin', 'hvigorw.js');
      javaPath = path.join(
        devecoStudioPath,
        'Contents',
        'jbr',
        'Contents',
        'Home',
        'bin',
        'java'
      );
      sdkPath = path.join(devecoStudioPath, 'Contents', 'sdk');
    } else {
      throw new Error('Linux is not fully supported yet');
    }

    ToolProvider.verifyTools(nodePath, ohpmJsPath, hvigorJsPath, javaPath);

    const hdcPath = ToolProvider.resolveHdcPath(sdkPath, platform);
    const emulatorPath = ToolProvider.resolveEmulatorPath(
      devecoStudioPath,
      platform
    );

    return {
      nodePath,
      ohpmJsPath,
      hvigorJsPath,
      javaPath,
      sdkPath,
      hdcPath,
      emulatorPath,
    };
  }

  private static resolveHdcPath(sdkPath: string, platform: string): string {
    const ext = platform === 'win32' ? '.exe' : '';
    const hdcPaths = [
      path.join(sdkPath, 'default', 'openharmony', 'toolchains', `hdc${ext}`),
      path.join(sdkPath, 'toolchains', `hdc${ext}`),
    ];

    for (const p of hdcPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    throw new Error(
      `hdc executable not found. Searched in:\n${hdcPaths.join('\n')}`
    );
  }

  private static resolveEmulatorPath(
    devecoStudioPath: string,
    platform: string
  ): string {
    let emulatorPath: string;

    if (platform === 'win32') {
      emulatorPath = path.join(
        devecoStudioPath,
        'tools',
        'emulator',
        'Emulator.exe'
      );
    } else if (platform === 'darwin') {
      emulatorPath = path.join(
        devecoStudioPath,
        'Contents',
        'tools',
        'emulator',
        'Emulator'
      );
    } else {
      throw new Error('Linux is not fully supported yet');
    }

    if (!fs.existsSync(emulatorPath)) {
      throw new Error(`Emulator executable not found at: ${emulatorPath}`);
    }

    return emulatorPath;
  }

  private static verifyTools(
    nodePath: string,
    ohpmJsPath: string,
    hvigorJsPath: string,
    javaPath: string
  ): void {
    if (!fs.existsSync(nodePath)) {
      throw new Error(`Node executable not found at: ${nodePath}`);
    }
    if (!fs.existsSync(ohpmJsPath)) {
      throw new Error(`ohpm js file not found at: ${ohpmJsPath}`);
    }
    if (!fs.existsSync(hvigorJsPath)) {
      throw new Error(`hvigor js file not found at: ${hvigorJsPath}`);
    }
    if (!fs.existsSync(javaPath)) {
      throw new Error(`java executable not found at: ${javaPath}`);
    }
  }

  /**
   * 获取模拟器可执行文件路径
   * @returns 模拟器可执行文件路径，如果不存在或不支持的平台则返回 null
   */
  private static async getEmulatorExe(): Promise<string | null> {
    const platform = os.platform();
    // Linux 平台不支持
    if (platform === 'linux') {
      return null;
    }
    const devecoStudioPath = await ToolProvider.findDevEcoStudio();
    let path: string;

    // Windows 平台
    if (platform === 'win32') {
      path = join(devecoStudioPath, 'tools', 'emulator', 'Emulator.exe');
    }
    // macOS 平台
    else if (platform === 'darwin') {
      path = join(
        devecoStudioPath,
        'contents',
        'tools',
        'emulator',
        'Emulator'
      );
    }
    // 其他平台
    else {
      return null;
    }

    // 检查路径是否存在
    if (existsSync(path)) {
      return path;
    }

    return null;
  }

  public detectApiLevel(): number {
    try {
      const sdkPkgPath = path.join(this.sdkPath, 'default', 'sdk-pkg.json');
      if (fs.existsSync(sdkPkgPath)) {
        const content = fs.readFileSync(sdkPkgPath, 'utf-8');
        const sdkPkg = JSON.parse(content);
        const apiVersion = sdkPkg?.data?.apiVersion;
        if (typeof apiVersion === 'string' || typeof apiVersion === 'number') {
          const level = Number(apiVersion);
          if (Number.isInteger(level) && level >= 17 && level <= 22) {
            return level;
          }
        }
      }
    } catch {
      // Ignore errors
    }

    try {
      const ohUniPaths = [
        path.join(
          this.sdkPath,
          'default',
          'openharmony',
          'toolchains',
          'oh-uni-package.json'
        ),
        path.join(
          this.sdkPath,
          'default',
          'openharmony',
          'native',
          'oh-uni-package.json'
        ),
        path.join(
          this.sdkPath,
          'default',
          'openharmony',
          'previewer',
          'oh-uni-package.json'
        ),
      ];

      for (const ohUniPath of ohUniPaths) {
        if (fs.existsSync(ohUniPath)) {
          const content = fs.readFileSync(ohUniPath, 'utf-8');
          const ohUni = JSON.parse(content);
          const apiVersion = ohUni?.apiVersion;
          if (
            typeof apiVersion === 'string' ||
            typeof apiVersion === 'number'
          ) {
            const level = Number(apiVersion);
            if (Number.isInteger(level) && level >= 17 && level <= 22) {
              return level;
            }
          }
        }
      }
    } catch {
      // Ignore errors
    }

    return 22;
  }
}
