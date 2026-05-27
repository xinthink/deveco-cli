/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import json5 from 'json5';
import { VENDOR_NAME } from './constants';

/** Maximum search depth for finding Harmony project */
const MAX_SEARCH_DEPTH = 3;

/** Maximum search depth for {@link smartFindToolPath}. */
const SMART_FIND_MAX_DEPTH = 3;

/** DevEco Studio 安装目录名(Windows / macOS 通用)。 */
const DEVECO_STUDIO_DIR_NAME = 'DevEco Studio';

/**
 * Tool-type identifiers used by {@link smartFindToolPath} / {@link checkPathValidity}.
 * Keep the string values aligned with the Rust constants (`TOOL_TYPE_*`).
 */
export const ToolType = {
  DevEcoStudio: 'deveco_studio'
} as const;
export type ToolType = (typeof ToolType)[keyof typeof ToolType];

/**
 * Check if a path is a Harmony project directory.
 */
export function isHarmonyosProject(dirPath: string): boolean {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return false;
  }

  const hasBuildProfile = fs.existsSync(path.join(dirPath, 'build-profile.json5'));
  const hasHvigorfile =
    fs.existsSync(path.join(dirPath, 'hvigorfile.js')) ||
    fs.existsSync(path.join(dirPath, 'hvigorfile.ts'));

  if (!hasBuildProfile || !hasHvigorfile) {
    return false;
  }

  // Verify build-profile.json5 has 'app' field (project-level)
  try {
    const content = fs.readFileSync(path.join(dirPath, 'build-profile.json5'), 'utf-8');
    const profile = json5.parse(content) as { app?: unknown };
    return profile.app !== undefined;
  } catch {
    return false;
  }
}

/**
 * Recursively search subdirectories for a Harmony project (BFS with depth limit).
 */
function searchHarmonyProject(
  currentDir: string,
  depth: number,
  maxDepth: number
): string | null {
  if (depth >= maxDepth) {
    return null;
  }

  const subDirs = collectSubDirs(currentDir);
  const directHit = findDirectHarmonyChild(subDirs);
  if (directHit) {
    return directHit;
  }

  for (const subDir of subDirs) {
    const found = searchHarmonyProject(subDir, depth + 1, maxDepth);
    if (found) {
      return found;
    }
  }
  return null;
}

function collectSubDirs(currentDir: string): string[] {
  try {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    const subDirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        subDirs.push(path.join(currentDir, entry.name));
      }
    }
    return subDirs;
  } catch {
    // Ignore permission errors
    return [];
  }
}

function findDirectHarmonyChild(subDirs: string[]): string | null {
  for (const subPath of subDirs) {
    if (isHarmonyosProject(subPath)) {
      return subPath;
    }
  }
  return null;
}

/**
 * Find a Harmony project starting from a given path.
 *
 * @param startPath - The starting path for the search
 * @returns The found project root directory, or null if not found
 */
export function findHarmonyProject(startPath: string): string | null {
  if (!startPath || startPath.trim() === '') {
    return null;
  }

  const resolvedPath = path.resolve(startPath);

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  // 1. Check self
  if (isHarmonyosProject(resolvedPath)) {
    return resolvedPath;
  }

  // 2. Check ancestors (up to 3 levels)
  let current = resolvedPath;
  for (let i = 1; i <= 3; i++) {
    const parent = path.dirname(current);
    if (parent === current) {
      break; // Reached root
    }
    if (isHarmonyosProject(parent)) {
      return parent;
    }
    current = parent;
  }

  // 3. Check descendants (BFS, depth limit 3)
  if (fs.statSync(resolvedPath).isDirectory()) {
    const found = searchHarmonyProject(resolvedPath, 0, MAX_SEARCH_DEPTH);
    if (found) {
      return found;
    }
  }

  return null;
}

export function findArktsLangServerPath(devecoPath?: string | null): string | null {
  if (process.platform === 'linux') {
    return null;
  }

  const devecoRoot = devecoPath ?? findDevEcoPath();
  if (!devecoRoot) {
    return null;
  }

  let pluginsOpenharmonyPath: string;
  if (process.platform === 'win32') {
    pluginsOpenharmonyPath = path.join(devecoRoot, 'plugins', 'openharmony');
  } else if (process.platform === 'darwin') {
    pluginsOpenharmonyPath = path.join(
      devecoRoot,
      'contents',
      'plugins',
      'openharmony'
    );
  } else {
    return null;
  }

  const aceServerIndexPath = path.join(
    pluginsOpenharmonyPath,
    'ace-server',
    'out',
    'index.js'
  );
  if (fs.existsSync(aceServerIndexPath)) {
    return pluginsOpenharmonyPath;
  }
  return null;
}

/**
 * clangd 在 DevEco Studio 安装目录下的相对路径。
 * 完整路径 = `<devecoHome>/<...CLANGD_RELATIVE_SEGMENTS>(.exe?)`。
 * 与 `wrapper.ts/CLANGD_RELATIVE_PATH_SEGMENTS` 保持一致。
 */
const CLANGD_RELATIVE_SEGMENTS = [
  'sdk',
  'default',
  'openharmony',
  'native',
  'llvm',
  'bin',
  'clangd',
] as const;

/**
 * 工程根下 `compile_commands.json` 的相对路径（由 DevEco / project_sync 生成）。
 */
export const COMPILE_COMMANDS_RELATIVE_SEGMENTS = [
  '.idea',
  '.deveco',
  'cxx',
  'compile_commands.json',
] as const;

/**
 * 把 DevEco 安装根目录映射为该平台下"放置 sdk/tools/plugins 的目录":
 *  - macOS: `<root>/Contents`
 *  - Windows / Linux: `<root>`
 */
function devecoContentRootForClangd(devecoHome: string): string {
  if (process.platform === 'darwin') {
    if (devecoHome.endsWith('.app')) {
      return path.join(devecoHome, 'Contents');
    }
  }
  return devecoHome;
}

/**
 * 给定 DevEco Studio 安装目录，返回 clangd 可能存在的候选路径。
 * 与 Rust 版本（`getClangdPathCandidatesFromDevecoHome`）的查找行为保持一致。
 */
function clangdCandidatesFromDevecoHome(devecoHome: string): string[] {
  const candidates = new Set<string>();
  const homes = [devecoHome, devecoContentRootForClangd(devecoHome)];
  for (const home of homes) {
    const base = path.join(home, ...CLANGD_RELATIVE_SEGMENTS);
    candidates.add(process.platform === 'win32' ? base + '.exe' : base);
  }
  return [...candidates];
}

/**
 * 查找系统上 clangd 可执行文件路径：
 * 1. 先看环境变量 `DEVECO_HOME` / `DEVECO_PATH`；
 * 2. 否则使用 {@link findDevEcoPath} 找到的 DevEco Studio 安装目录。
 * 找到第一个存在的候选路径就返回；都不存在返回 null。
 */
export function findClangdPath(devecoPath?: string | null): string | null {
  const checked: string[] = [];

  const envHome = process.env.DEVECO_HOME ?? process.env.DEVECO_PATH;
  if (envHome && envHome.trim()) {
    for (const c of clangdCandidatesFromDevecoHome(envHome.trim())) {
      checked.push(c);
      if (fs.existsSync(c)) {
        return c;
      }
    }
  }

  const devecoRoot = devecoPath ?? findDevEcoPath();
  if (devecoRoot) {
    for (const c of clangdCandidatesFromDevecoHome(devecoRoot)) {
      checked.push(c);
      if (fs.existsSync(c)) {
        return c;
      }
    }
  }

  return null;
}

/**
 * 工程根下 `compile_commands.json` 的绝对路径。
 */
export function compileCommandsPath(projectPath: string): string {
  return path.join(projectPath, ...COMPILE_COMMANDS_RELATIVE_SEGMENTS);
}

export function findDevEcoPath(): string | null {
  if (process.platform === 'win32') {
    const candidates = [
      path.join('C:\\Program Files', VENDOR_NAME, DEVECO_STUDIO_DIR_NAME),
      path.join('C:\\Program Files (x86)', VENDOR_NAME, DEVECO_STUDIO_DIR_NAME),
    ];
    return firstExistingPath(candidates);
  }
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/DevEco Studio.app',
      path.join(process.env.HOME ?? '', 'Applications', 'DevEco Studio.app'),
    ];
    return firstExistingPath(candidates);
  }
  return null;
}

function firstExistingPath(candidates: string[]): string | null {
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Resolve the platform-specific sub-directory inside a DevEco Studio install
 * (Windows -> `<root>`, macOS -> `<root>/Contents`). The result is the
 * directory that should contain `plugins/`, `sdk/`, `tools/` etc.
 */
export function devecoStudioContentRoot(dir: string): string {
  if (process.platform === 'darwin') {
    return path.join(dir, 'Contents');
  }
  return dir;
}

/**
 * Return true when `dir` looks like a usable DevEco Studio installation
 * (has at least `plugins/openharmony` or a bundled `sdk` / `tools`).
 */
export function isDevecoStudioPathAvailable(dir: string): boolean {
  if (!dir || !fs.existsSync(dir) || !safeIsDirectory(dir)) {
    return false;
  }
  const root = devecoStudioContentRoot(dir);
  const markers = [
    path.join(root, 'plugins', 'openharmony'),
    path.join(root, 'sdk'),
    path.join(root, 'tools'),
  ];
  return markers.some((p) => fs.existsSync(p));
}

/**
 * Locate an emulator system-image directory under `start` (i.e. a directory
 * containing one or more `<deviceType>/<osVersion>` sub-folders).
 */
export function getEmulatorImagePath(start?: string | null): string | null {
  if (!start || !fs.existsSync(start) || !safeIsDirectory(start)) {
    return null;
  }
  const candidates = [
    start,
    path.join(start, 'images'),
    path.join(start, 'emulator', 'images'),
    path.join(devecoStudioContentRoot(start), 'tools', 'emulator', 'images'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && safeIsDirectory(c)) {
      return c;
    }
  }
  return null;
}

function safeIsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Validate whether `dirPath` is usable for the given `toolType`.
 */
export function checkPathValidity(dirPath: string, toolType: string): boolean {
  if (!dirPath || !fs.existsSync(dirPath)) {
    return false;
  }
  switch (toolType) {
    case ToolType.DevEcoStudio:
      return isDevecoStudioPathAvailable(dirPath);
    default:
      return false;
  }
}

/**
 * "Smart" search for a tool installation directory given a (possibly
 * imprecise) starting `dirPath`.
 */
export function smartFindToolPath(dirPath: string, toolType: ToolType = ToolType.DevEcoStudio): string {
  if (!dirPath) {
    return '';
  }

  // 1. Check self.
  if (checkPathValidity(dirPath, toolType)) {
    return dirPath;
  }

  // 2. Check ancestors (up to SMART_FIND_MAX_DEPTH levels).
  const ancestorHit = findAncestorWithValidTool(dirPath, toolType);
  if (ancestorHit) {
    return ancestorHit;
  }

  // 3. Check descendants (BFS, depth limit SMART_FIND_MAX_DEPTH).
  const descendantHit = findDescendantWithValidTool(dirPath, toolType);
  if (descendantHit) {
    return descendantHit;
  }

  return dirPath;
}

function findAncestorWithValidTool(dirPath: string, toolType: ToolType): string | null {
  let current = dirPath;
  for (let i = 0; i < SMART_FIND_MAX_DEPTH; i++) {
    const parent = path.dirname(current);
    if (!parent || parent === current) {
      break;
    }
    if (checkPathValidity(parent, toolType)) {
      return parent;
    }
    current = parent;
  }
  return null;
}

function findDescendantWithValidTool(dirPath: string, toolType: ToolType): string | null {
  if (!fs.existsSync(dirPath) || !safeIsDirectory(dirPath)) {
    return null;
  }
  const queue: Array<{ p: string; depth: number }> = [{ p: dirPath, depth: 0 }];
  while (queue.length > 0) {
    const { p, depth } = queue.shift()!;
    if (depth >= SMART_FIND_MAX_DEPTH) {
      continue;
    }
    const hit = scanDescendantLevel(p, depth, toolType, queue);
    if (hit) {
      return hit;
    }
  }
  return null;
}

function scanDescendantLevel(
  parent: string,
  depth: number,
  toolType: ToolType,
  queue: Array<{ p: string; depth: number }>
): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return null; // permission / IO error — skip silently
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sub = path.join(parent, entry.name);
    if (checkPathValidity(sub, toolType)) {
      return sub;
    }
    queue.push({ p: sub, depth: depth + 1 });
  }
  return null;
}

/** 通用 sleep 工具。 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 受 clangd 支持的 C/C++ 源 / 头文件扩展名（小写、无前导点）。
 * 与 Rust 版本 `is_supported_cpp_file` 保持一致。
 */
const CPP_SUPPORTED_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cxx',
  'c++',
  'h',
  'hh',
  'hpp',
  'hxx',
  'h++',
  'ipp',
  'ixx',
  'inl',
  'inc',
  'tpp',
]);

/** 判断给定文件路径是否是受支持的 C/C++ 源 / 头文件。 */
export function isSupportedCppFile(filePath: string): boolean {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  return ext.length > 0 && CPP_SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * 根据文件后缀推断 LSP `languageId`。
 * - `.c` → `c`
 * - 其它（`.cpp/.cc/.hpp/...`） → `cpp`
 */
export function inferCppLanguageId(filePath: string): 'c' | 'cpp' {
  const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
  return ext === 'c' ? 'c' : 'cpp';
}

/**
 * 规范化为正斜杠路径；Windows 下盘符大写。
 */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(s)) {
    s = s[0].toUpperCase() + s.slice(1);
  }
  return s;
}

/**
 * 转为"标准路径"（无 file:// 前缀），用于在 LSP 消息中发送。
 *  - Windows: D:/path/to/file.ets
 *  - Mac/Linux: /path/to/file.ets
 */
export function toStandardPath(p: string): string {
  return normalizePath(p);
}

/**
 * 转为 file URI（可用作 diagnostic_waiters 的 key）。
 */
export function toFileUri(p: string): string {
  const std = toStandardPath(p);
  if (std.startsWith('/')) {
    return `file://${std}`;
  }
  return `file:///${std}`;
}

/**
 * 把 LSP 返回的 file URI 规范化为与 {@link toFileUri} 一致的形式。
 */
export function normalizeDiagnosticUri(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === 'file:') {
      // u.pathname 形如 /D:/foo/bar 或 /foo/bar
      let pathPart = decodeURIComponent(u.pathname);
      // Windows: 去掉前导斜杠（/D:/foo -> D:/foo）
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(pathPart)) {
        pathPart = pathPart.slice(1);
      }
      return toFileUri(pathPart);
    }
  } catch {
    // 不是合法 URL，原样返回
  }
  return uri;
}

/**
 * 对可能被 proxy/ace 写坏的 uri 生成候选 key（例如
 * `.../src-server/file:/D%3A/.../Index.ets`），用于二次匹配。
 */
export function diagnosticUriCandidates(uri: string): string[] {
  const out: string[] = [];
  const idx = uri.lastIndexOf('file:/');
  if (idx >= 0) {
    const suffix = uri.slice(idx).replace(/^file:\/+/, '');
    if (suffix) {
      const repaired = suffix.startsWith('/')
        ? `file://${suffix}`
        : `file:///${suffix}`;
      const candidate = normalizeDiagnosticUri(repaired);
      if (candidate !== uri && candidate !== normalizeDiagnosticUri(uri)) {
        out.push(candidate);
      }
    }
  }
  return out;
}

/**
 * 获取 MCP server 日志根目录。
 *  - Windows: `%LOCALAPPDATA%/devecocli-mcp-server/logs`
 *  - macOS:   `~/Library/Logs/devecocli-mcp-server`
 *  - Linux:   `~/.local/share/devecocli-mcp-server/logs`
 */
export function getMcpLogDirectory(): string {
  if (process.platform === 'win32') {
    const localAppData =
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'devecocli-mcp-server', 'logs');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Logs', 'devecocli-mcp-server');
  }
  return path.join(os.homedir(), '.local', 'share', 'devecocli-mcp-server', 'logs');
}

/**
 * 读取 / 维护 mapping-config.properties，把 `key`（通常是工程根路径）
 * 映射到一个稳定的数字 ID（首次写入时取 `Date.now()`）。
 */
export function getRequestId(key: string, mappingConfigPath: string): number {
  const lines = readMappingLines(mappingConfigPath);
  const existing = lookupExistingId(lines, key);
  if (existing !== null) {
    return existing;
  }

  const timestamp = Date.now();
  const escapedKey = key.replace(/:/g, '\\:');
  const newLine = `${escapedKey}=${timestamp}`;
  const updatedLines = upsertMappingLine(lines, key, newLine);
  writeMappingLines(mappingConfigPath, updatedLines);
  return timestamp;
}

function readMappingLines(mappingConfigPath: string): string[] {
  let existing: string;
  try {
    existing = fs.readFileSync(mappingConfigPath, 'utf8');
  } catch {
    existing = '';
  }
  return existing.length > 0 ? existing.split(/\r?\n/) : [];
}

function lookupExistingId(lines: string[], key: string): number | null {
  for (const line of lines) {
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const rawKey = line.slice(0, eq);
    if (rawKey.replace(/\\:/g, ':') !== key) {
      continue;
    }
    const n = parseInt(line.slice(eq + 1), 10);
    if (Number.isFinite(n) && n > 0) {
      return n;
    }
    return null; // key 命中但 value 非法 -> 重新生成
  }
  return null;
}

function upsertMappingLine(lines: string[], key: string, newLine: string): string[] {
  let replaced = false;
  const updated = lines.map((line) => {
    if (replaced) {
      return line;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      return line;
    }
    const rawKey = line.slice(0, eq);
    if (rawKey.replace(/\\:/g, ':') === key) {
      replaced = true;
      return newLine;
    }
    return line;
  });
  if (!replaced) {
    updated.push(newLine);
  }
  return updated;
}

function writeMappingLines(mappingConfigPath: string, lines: string[]): void {
  try {
    fs.mkdirSync(path.dirname(mappingConfigPath), { recursive: true });
  } catch {
    // ignore
  }
  try {
    fs.writeFileSync(mappingConfigPath, lines.join('\n') + '\n', 'utf8');
  } catch {
    // ignore
  }
}

/**
 * 清理 `baseDir` 下超过 `maxAgeMs` 未修改的子目录。
 *
 * @param currentPath 当前正在使用的子目录路径
 * @param maxAgeMs 最大保留时间（毫秒）
 * @param logTag 日志前缀，默认 `[Cleanup]`
 */
export function cleanupOldSiblingDirs(
  currentPath: string,
  maxAgeMs: number,
  logTag = '[Cleanup]'
): void {
  try {
    const baseDir = path.dirname(currentPath);
    if (!fs.existsSync(baseDir)) {
      return;
    }
    const now = Date.now();
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      removeIfExpired(path.join(baseDir, entry.name), now, maxAgeMs, logTag);
    }
  } catch {
    // ignore
  }
}

function removeIfExpired(full: string, now: number, maxAgeMs: number, logTag: string): void {
  try {
    const { mtimeMs } = fs.statSync(full);
    if (now - mtimeMs <= maxAgeMs) {
      return;
    }
    fs.rmSync(full, { recursive: true, force: true });
    const ageSecs = Math.floor((now - mtimeMs) / 1000);
    console.error(
      `${logTag} Removed expired dir (age ${Math.floor(ageSecs / 86400)}d ${Math.floor(
        (ageSecs % 86400) / 3600
      )}h): ${full}`
    );
  } catch (e) {
    console.error(`${logTag} Failed to remove expired dir ${full}: ${e}`);
  }
}