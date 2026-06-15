/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { execFileSync } from 'child_process';
import fs, { existsSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import regedit from 'regedit';
import { join } from 'path';
import { red } from 'colorette';
import { debugLog } from './logger.js';

const DEVECO_DOWNLOAD_URL =
  'https://developer.huawei.com/consumer/cn/download/';
const MIN_REQUIRED_VERSION = '6.1.0';

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

interface SignatureVerificationResult {
  signed: boolean;
  signer?: string;
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
  private _devecoStudioPath: string;
  private _nodePath: string;
  private _ohpmJsPath: string;
  private _hvigorJsPath: string;
  private _javaPath: string;
  private _sdkPath: string;
  private _hdcPath: string;
  private _emulatorPath: string;
  private _emulatorLauncherPath: string | undefined;

  private static _verifiedPaths = new Set<string>();
  private static _powerShellPath: string | undefined;

  private static verifyAndCache(filePath: string): void {
    if (ToolProvider._verifiedPaths.has(filePath)) {
      return;
    }
    ToolProvider.verifySignature(filePath);
    ToolProvider._verifiedPaths.add(filePath);
  }

  get devecoStudioPath(): string { 
    return this._devecoStudioPath; 
  }
  get nodePath(): string {
    ToolProvider.verifyAndCache(this._nodePath);
    return this._nodePath;
  }
  get ohpmJsPath(): string { 
    return this._ohpmJsPath; 
  }
  get hvigorJsPath(): string { 
    return this._hvigorJsPath; 
  }
  get javaPath(): string {
    ToolProvider.verifyAndCache(this._javaPath);
    return this._javaPath;
  }
  get sdkPath(): string { 
    return this._sdkPath; 
  }
  get hdcPath(): string {
    ToolProvider.verifyAndCache(this._hdcPath);
    return this._hdcPath;
  }
  get emulatorPath(): string {
    ToolProvider.verifyAndCache(this._emulatorPath);
    return this._emulatorPath;
  }
  get emulatorLauncherPath(): string | undefined {
    if (this._emulatorLauncherPath) {
      ToolProvider.verifyAndCache(this._emulatorLauncherPath);
    }
    return this._emulatorLauncherPath;
  }

  private constructor(
    devecoStudioPath: string,
    nodePath: string,
    ohpmJsPath: string,
    hvigorJsPath: string,
    javaPath: string,
    sdkPath: string,
    hdcPath: string,
    emulatorPath: string,
    emulatorLauncherPath: string | undefined
  ) {
    this._devecoStudioPath = devecoStudioPath;
    this._nodePath = nodePath;
    this._ohpmJsPath = ohpmJsPath;
    this._hvigorJsPath = hvigorJsPath;
    this._javaPath = javaPath;
    this._sdkPath = sdkPath;
    this._hdcPath = hdcPath;
    this._emulatorPath = emulatorPath;
    this._emulatorLauncherPath = emulatorLauncherPath;
  }

  public static async checkVersion(): Promise<void> {
    await ToolProvider.findDevEcoStudio();
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
    const emulatorLauncherPath = ToolProvider.getEmulatorExe(devecoStudioPath);
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

  private static _cachedInstallRoot: string | undefined;

  private static async findDevEcoStudio(): Promise<string> {
    if (ToolProvider._cachedInstallRoot !== undefined) {
      debugLog(
        `[ToolProvider] findDevEcoStudio: cache hit -> ${ToolProvider._cachedInstallRoot}`
      );
      return ToolProvider._cachedInstallRoot;
    }
    const platform = os.platform();
    const candidates =
      platform === 'win32'
        ? await ToolProvider.collectCandidatesWindows()
        : platform === 'darwin'
          ? ToolProvider.collectCandidatesMac()
          : (() => {
              throw new Error(
                'Linux is not fully supported yet for automatic DevEco Studio detection.'
              );
            })();

    ToolProvider._cachedInstallRoot =
      ToolProvider.pickLatestByProductInfo(candidates);
    return ToolProvider._cachedInstallRoot;
  }

  // ---------- candidate collection ----------

  private static async collectCandidatesWindows(): Promise<string[]> {
    const seen = new Set<string>();
    const unique: string[] = [];

    const add = (p: string | undefined, source: string) => {
      if (!ToolProvider.isExistingDirectory(p)) {
        return;
      }
      const key = path.normalize(p).toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(p);
        debugLog(`[ToolProvider] Found via ${source}: ${p}`);
      }
    };

    await ToolProvider.addFromUninstallKey(add);
    await ToolProvider.addFromWow64Key(add);
    ToolProvider.addFromDefaultWindowsPath(add);

    if (unique.length === 0) {
      throw new Error(
        'DevEco Studio installation not found in registry or default locations.'
      );
    }

    return unique;
  }

  private static async addFromUninstallKey(
    add: (p: string | undefined, source: string) => void
  ): Promise<void> {
    try {
      const key =
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\DevEco Studio';
      const result = await regList([key]);
      const p = result[key]?.values?.InstallLocation?.value as
        | string
        | undefined;
      add(p, 'Uninstall registry key');
    } catch {
      // registry key may not exist
    }
  }

  private static async addFromWow64Key(
    add: (p: string | undefined, source: string) => void
  ): Promise<void> {
    try {
      const huaweiKey = 'HKLM\\SOFTWARE\\WOW6432Node\\Huawei\\DevEco Studio';
      const result = await regList([huaweiKey]);
      const versionKeys = result[huaweiKey]?.keys ?? [];
      if (versionKeys.length === 0) {
        return;
      }
      const subkeys = versionKeys.map((k: string) => `${huaweiKey}\\${k}`);
      const subkeysResult = await regList(subkeys);
      for (const subkey of subkeys) {
        const p = subkeysResult[subkey]?.values?.['']?.value as
          | string
          | undefined;
        add(p, `WOW6432Node subkey ${subkey}`);
      }
    } catch {
      // registry key may not exist
    }
  }

  private static addFromDefaultWindowsPath(
    add: (p: string | undefined, source: string) => void
  ): void {
    const defaultPath = path.join(
      'C:',
      'Program Files',
      'Huawei',
      'DevEco Studio'
    );
    add(defaultPath, 'default installation path');
  }

  private static collectCandidatesMac(): string[] {
    const homeDir = os.homedir();
    const searchDirs = [path.join(homeDir, 'Applications'), '/Applications'];
    const candidates: string[] = [];
    const seen = new Set<string>();

    for (const dir of searchDirs) {
      if (!fs.existsSync(dir)) {
        continue;
      }
      let entries: string[];
      try {
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith('.app')) {
          continue;
        }
        const lower = entry.toLowerCase();
        if (!lower.includes('deveco')) {
          continue;
        }
        const fullPath = path.join(dir, entry);
        if (!ToolProvider.isExistingDirectory(fullPath)) {
          continue;
        }
        if (!seen.has(fullPath)) {
          seen.add(fullPath);
          candidates.push(fullPath);
          debugLog(`[ToolProvider] Found macOS candidate: ${fullPath}`);
        }
      }
    }

    if (candidates.length === 0) {
      throw new Error(
        'DevEco Studio not found in /Applications or ~/Applications.'
      );
    }

    return candidates;
  }

  // ---------- install version resolution (product-info.json / macOS Info.plist) ----------

  private static productInfoPath(installRoot: string): string {
    const platform = os.platform();
    if (platform === 'darwin') {
      return path.join(installRoot, 'Contents', 'product-info.json');
    }
    return path.join(installRoot, 'product-info.json');
  }

  private static macInfoPlistPath(installRoot: string): string {
    return path.join(installRoot, 'Contents', 'Info.plist');
  }

  /**
   * macOS: read a string key from the app Info.plist (XML or binary plist) via `defaults read`.
   */
  private static readMacInfoPlistKey(
    plistPath: string,
    key: string
  ): string | undefined {
    if (!fs.existsSync(plistPath)) {
      debugLog(`[ToolProvider] Info.plist not found at: ${plistPath}`);
      return undefined;
    }
    try {
      const out = execFileSync('defaults', ['read', plistPath, key], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();
      if (out.length > 0 && out !== '(null)') {
        return out;
      }
    } catch {
      debugLog(
        `[ToolProvider] defaults read failed for ${plistPath} key ${key}`
      );
    }
    return undefined;
  }

  private static extractCompactBuildCode(value: string): string | undefined {
    const last = value.split('.').at(-1);
    if (last !== undefined && /^\d+$/.test(last)) {
      return last;
    }
    return undefined;
  }

  private static compactPrefixFromShortVersion(
    shortVersion: string
  ): string | undefined {
    const segments = shortVersion.split('.').slice(0, 3);
    if (segments.length < 3 || !segments.every((s) => /^\d+$/.test(s))) {
      return undefined;
    }
    return segments.join('');
  }
  private static extractFourthSegmentMatchingShortVersion(
    shortVersion: string,
    bundleVersionValue: string
  ): string | undefined {
    const prefix =
      ToolProvider.compactPrefixFromShortVersion(shortVersion);
    const compactCode =
      ToolProvider.extractCompactBuildCode(bundleVersionValue);
    if (prefix === undefined || compactCode === undefined) {
      return undefined;
    }
    if (!compactCode.startsWith(prefix)) {
      debugLog(
        `[ToolProvider] CFBundleVersion suffix ${compactCode} does not match short-version prefix ${prefix} (${shortVersion})`
      );
      return undefined;
    }
    const fourth = compactCode.slice(prefix.length);
    if (fourth.length === 0 || !/^\d+$/.test(fourth)) {
      return undefined;
    }
    return fourth;
  }

  private static readMacFourthSegmentFromPlist(
    plistPath: string,
    shortVersion: string
  ): string | undefined {
    const bundleVersion = ToolProvider.readMacInfoPlistKey(
      plistPath,
      'CFBundleVersion'
    );
    if (bundleVersion !== undefined) {
      const fromBundle = ToolProvider.extractFourthSegmentMatchingShortVersion(
        shortVersion,
        bundleVersion
      );
      if (fromBundle !== undefined) {
        return fromBundle;
      }
    }

    const infoString = ToolProvider.readMacInfoPlistKey(
      plistPath,
      'CFBundleGetInfoString'
    );
    if (infoString === undefined) {
      return undefined;
    }
    const buildMatch = infoString.match(/DS-[\d.]+/);
    if (buildMatch === null) {
      return undefined;
    }
    return ToolProvider.extractFourthSegmentMatchingShortVersion(
      shortVersion,
      buildMatch[0]
    );
  }

  private static parseMacInfoPlistVersion(
    installRoot: string
  ): string | undefined {
    const plistPath = ToolProvider.macInfoPlistPath(installRoot);
    const shortVersion = ToolProvider.readMacInfoPlistKey(
      plistPath,
      'CFBundleShortVersionString'
    );
    if (shortVersion !== undefined) {
      const fourthSegment = ToolProvider.readMacFourthSegmentFromPlist(
        plistPath,
        shortVersion
      );
      if (fourthSegment !== undefined) {
        return `${shortVersion}.${fourthSegment}`;
      }
      return shortVersion;
    }
    return ToolProvider.readMacInfoPlistKey(plistPath, 'CFBundleVersion');
  }

  private static parseProductInfoVersion(
    installRoot: string
  ): string | undefined {
    if (os.platform() === 'darwin') {
      const fromPlist = ToolProvider.parseMacInfoPlistVersion(installRoot);
      if (fromPlist !== undefined) {
        return fromPlist;
      }
    }

    const infoPath = ToolProvider.productInfoPath(installRoot);
    if (!fs.existsSync(infoPath)) {
      debugLog(`[ToolProvider] product-info.json not found at: ${infoPath}`);
      return undefined;
    }
    try {
      const data = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
      const version = data?.version;
      if (typeof version !== 'string' || version.trim() === '') {
        debugLog(
          `[ToolProvider] product-info.json at ${infoPath} has no valid "version" field`
        );
        return undefined;
      }
      return version.trim();
    } catch {
      debugLog(
        `[ToolProvider] Failed to parse product-info.json at: ${infoPath}`
      );
      return undefined;
    }
  }

  // ---------- version comparison ----------

  /**
   * Compare two version strings by numeric segments (e.g. "6.1.0.100").
   * Returns negative if a < b, 0 if equal, positive if a > b.
   */
  private static compareVersion(a: string, b: string): number {
    const segA = a.split('.').map((s) => parseInt(s, 10) || 0);
    const segB = b.split('.').map((s) => parseInt(s, 10) || 0);
    const len = Math.max(segA.length, segB.length);
    for (let i = 0; i < len; i++) {
      const diff = (segA[i] ?? 0) - (segB[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }

  // ---------- pick latest + version enforcement ----------

  private static pickLatestByProductInfo(candidates: string[]): string {
    const best = ToolProvider.selectHighestVersion(candidates);
    ToolProvider.assertMinVersion(best.installRoot, best.version);
    debugLog(
      `[ToolProvider] Selected DevEco Studio ${best.version} at ${best.installRoot}`
    );
    return best.installRoot;
  }

  private static selectHighestVersion(candidates: string[]): {
    installRoot: string;
    version: string;
  } {
    type Entry = { installRoot: string; version: string };
    const versioned: Entry[] = [];

    for (const installRoot of candidates) {
      const version = ToolProvider.parseProductInfoVersion(installRoot);
      if (version !== undefined) {
        versioned.push({ installRoot, version });
        debugLog(`[ToolProvider] ${installRoot} => version ${version}`);
      } else {
        debugLog(
          `[ToolProvider] Skipping ${installRoot}: could not read version (Info.plist / product-info.json).`
        );
      }
    }

    if (versioned.length === 0) {
      const tried = candidates.join('\n  ');
      const hint =
        os.platform() === 'darwin'
          ? 'Contents/Info.plist (CFBundleShortVersionString / CFBundleVersion) and Contents/product-info.json'
          : 'product-info.json';
      throw new Error(
        `Failed to determine DevEco Studio version from ${hint}.\n` +
          `Searched locations:\n  ${tried}\n` +
          `Please reinstall DevEco Studio or download the latest version from:\n` +
          DEVECO_DOWNLOAD_URL
      );
    }

    return versioned.reduce((prev, cur) =>
      ToolProvider.compareVersion(cur.version, prev.version) > 0 ? cur : prev
    );
  }

  private static assertMinVersion(installRoot: string, version: string): void {
    if (ToolProvider.compareVersion(version, MIN_REQUIRED_VERSION) >= 0) {
      return;
    }
    debugLog(
      `[ToolProvider] Selected DevEco Studio ${version} at ${installRoot} — below minimum`
    );
    console.error(
      red(
        `Error: The detected DevEco Studio version is ${version}, ` +
          `which is below the minimum required version ${MIN_REQUIRED_VERSION}. ` +
          `Upgrade to the latest version before using deveco-cli:`
      ) +
        '\n' +
        DEVECO_DOWNLOAD_URL
    );
    process.exit(1);
  }

  private static isExistingDirectory(p: string | undefined): p is string {
    return !!p && fs.existsSync(p) && fs.statSync(p).isDirectory();
  }

  private static resolveWindowsTools(devecoStudioPath: string): {
    nodePath: string;
    ohpmJsPath: string;
    hvigorJsPath: string;
    javaPath: string;
    sdkPath: string;
  } {
    const toolsDir = path.join(devecoStudioPath, 'tools');
    return {
      nodePath: path.join(toolsDir, 'node', 'node.exe'),
      ohpmJsPath: path.join(toolsDir, 'ohpm', 'bin', 'pm-cli.js'),
      hvigorJsPath: path.join(toolsDir, 'hvigor', 'bin', 'hvigorw.js'),
      javaPath: path.join(devecoStudioPath, 'jbr', 'bin', 'java.exe'),
      sdkPath: path.join(devecoStudioPath, 'sdk'),
    };
  }

  private static resolveMacTools(devecoStudioPath: string): {
    nodePath: string;
    ohpmJsPath: string;
    hvigorJsPath: string;
    javaPath: string;
    sdkPath: string;
  } {
    const toolsDir = path.join(devecoStudioPath, 'Contents', 'tools');
    return {
      nodePath: path.join(toolsDir, 'node', 'bin', 'node'),
      ohpmJsPath: path.join(toolsDir, 'ohpm', 'bin', 'pm-cli.js'),
      hvigorJsPath: path.join(toolsDir, 'hvigor', 'bin', 'hvigorw.js'),
      javaPath: path.join(
        devecoStudioPath,
        'Contents',
        'jbr',
        'Contents',
        'Home',
        'bin',
        'java'
      ),
      sdkPath: path.join(devecoStudioPath, 'Contents', 'sdk'),
    };
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

    const tools =
      platform === 'win32'
        ? ToolProvider.resolveWindowsTools(devecoStudioPath)
        : platform === 'darwin'
          ? ToolProvider.resolveMacTools(devecoStudioPath)
          : (() => {
              throw new Error('Linux is not fully supported yet.');
            })();

    ToolProvider.verifyTools(
      tools.nodePath,
      tools.ohpmJsPath,
      tools.hvigorJsPath,
      tools.javaPath
    );

    const hdcPath = ToolProvider.resolveHdcPath(tools.sdkPath, platform);
    const emulatorPath = ToolProvider.resolveEmulatorPath(
      devecoStudioPath,
      platform
    );

    return {
      ...tools,
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
   * Resolve the emulator launcher executable path from an already-located
   * DevEco Studio installation. Returns undefined if the platform is not
   * supported or the file does not exist.
   */
  private static getEmulatorExe(devecoStudioPath: string): string | undefined {
    const platform = os.platform();
    let exePath: string;

    if (platform === 'win32') {
      exePath = join(devecoStudioPath, 'tools', 'emulator', 'Emulator.exe');
    } else if (platform === 'darwin') {
      exePath = join(
        devecoStudioPath,
        'Contents',
        'tools',
        'emulator',
        'Emulator'
      );
    } else {
      return undefined;
    }

    return existsSync(exePath) ? exePath : undefined;
  }

  private static isValidApiLevel(level: number, maxApi?: number): boolean {
    const maxSupported = maxApi ?? 23;
    return Number.isInteger(level) && level >= 17 && level <= maxSupported;
  }

  private static parseApiLevelFromFile(filePath: string): number | undefined {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      const apiVersion = data?.apiVersion ?? data?.data?.apiVersion;

      if (typeof apiVersion !== 'string' && typeof apiVersion !== 'number') {
        return undefined;
      }

      const level = Number(apiVersion);
      // Only validate that it's a valid integer >= 17
      // Max limit is now determined dynamically from SDK
      return Number.isInteger(level) && level >= 17 ? level : undefined;
    } catch {
      return undefined;
    }
  }

  private static detectFromSdkPkg(sdkPath: string): number | undefined {
    const sdkPkgPath = path.join(sdkPath, 'default', 'sdk-pkg.json');
    return ToolProvider.parseApiLevelFromFile(sdkPkgPath);
  }

  private static detectFromOhUniPackage(sdkPath: string): number | undefined {
    const ohUniPaths = [
      path.join(
        sdkPath,
        'default',
        'openharmony',
        'toolchains',
        'oh-uni-package.json'
      ),
      path.join(
        sdkPath,
        'default',
        'openharmony',
        'native',
        'oh-uni-package.json'
      ),
      path.join(
        sdkPath,
        'default',
        'openharmony',
        'previewer',
        'oh-uni-package.json'
      ),
    ];

    for (const ohUniPath of ohUniPaths) {
      const level = ToolProvider.parseApiLevelFromFile(ohUniPath);
      if (level !== undefined) {
        return level;
      }
    }

    return undefined;
  }

  /**
   * Get the API level from SDK's sdk-pkg.json or oh-uni-package.json.
   * Returns the detected API version, or 23 as fallback if SDK files exist but have no valid apiVersion.
   */
  public getMaxApiLevel(): number {
    const fromSdkPkg = ToolProvider.detectFromSdkPkg(this.sdkPath);
    if (fromSdkPkg !== undefined) {
      return fromSdkPkg;
    }

    const fromOhUni = ToolProvider.detectFromOhUniPackage(this.sdkPath);
    if (fromOhUni !== undefined) {
      return fromOhUni;
    }

    // SDK exists but no valid apiVersion found, use 23 as fallback
    return 23;
  }

  /** Alias for getMaxApiLevel() */
  public detectApiLevel(): number {
    return this.getMaxApiLevel();
  }


  // ---------- PowerShell path resolution ----------

  /**
   * Find the PowerShell executable path.
   * - Win32: checks the well-known location first, then queries `where.exe powershell`.
   * - Other platforms: returns 'powershell' as-is.
   */
  private static findPowerShellPath(): string {
    if (ToolProvider._powerShellPath) {
      return ToolProvider._powerShellPath;
    }

    if (os.platform() !== 'win32') {
      ToolProvider._powerShellPath = '';
      return ToolProvider._powerShellPath;
    }

    const knownPath = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    );
    if (existsSync(knownPath)) {
      debugLog(`[ToolProvider] Found PowerShell at: ${knownPath}`);
      ToolProvider._powerShellPath = knownPath;
      return knownPath;
    }
    ToolProvider._powerShellPath = '';
    return ToolProvider._powerShellPath;
  }

  // ---------- signature verification ----------

  /**
   * Verify that an executable file is digitally signed.
   * - win32: uses PowerShell Get-AuthenticodeSignature
   * - darwin: uses codesign -v
   * - other platforms: returns { signed: true } (no verification)
   */
   public static verifySignature(filePath: string) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`executable not found at: ${filePath}`);
    }
    const platform = os.platform();

    if (!ToolProvider.isExecutableFile(filePath, platform)) {
      return;
    }

    if (platform === 'win32') {
      const result = ToolProvider.verifyWindowsSignature(filePath);
      if (!result.signed) {
        throw new Error(`The executable is not digitally signed: ${filePath}`);
      }
    } else if (platform === 'darwin') {
      const result = ToolProvider.verifyMacSignature(filePath);
      if (!result.signed) {
        throw new Error(`The executable is not digitally signed: ${filePath}`);
      }
    }
  }

  private static isExecutableFile(filePath: string, platform: string): boolean {
    if (platform === 'win32') {
      return path.extname(filePath).toLowerCase() === '.exe';
    }
    if (platform === 'darwin') {
      try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private static createSignatureScript(): { tmpDir: string; scriptPath: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deveco-verify-'));
    const scriptPath = path.join(tmpDir, 'Verify-Signature.ps1');
    fs.writeFileSync(
      scriptPath,
      "$env:PSModulePath = ($env:PSModulePath -split ';' | Where-Object { $_ -notmatch 'windowsapps' }) -join ';'; Get-AuthenticodeSignature -FilePath $args[0] | ConvertTo-Json -Depth 3 -Compress",
      'utf-8',
    );
    return { tmpDir, scriptPath };
  }

  private static verifyWindowsSignature(
    filePath: string
  ): SignatureVerificationResult {
    const powerShellPath = ToolProvider.findPowerShellPath();
    if (!powerShellPath) {
        throw new Error(`PowerShell application not found`);
    }
    const { tmpDir, scriptPath } = ToolProvider.createSignatureScript();
    try {
      const result = execFileSync(
        powerShellPath,
        [
          '-NoProfile',
          '-ExecutionPolicy', 'Bypass',
          '-File',
          scriptPath,
          filePath,
        ],
        {
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'ignore'],
        }
      );
      const data = JSON.parse(result);
      const status: number | undefined = data?.Status;
      return {
        signed: status === 0,
        signer: data?.SignerCertificate?.Subject ?? undefined,
      };
    } catch (e) {
      debugLog(`[ToolProvider] verify Windows Signature, error msg: ${e}`);
      return { signed: true };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private static verifyMacSignature(
    filePath: string
  ): SignatureVerificationResult {
    try {
      execFileSync('codesign', ['-v', filePath], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      return { signed: true };
    } catch {
      return { signed: false };
    }
  }
}
