/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModuleInfoParse } from '../parse/ModuleInfoParse.js';
import { executeBuildCommand } from './buildProject.js';
import { CommonUtils } from '../../../../src/utils/common-utils.js';
import { compileCommandsPath } from '../../utils/common.js';
import { mcpLog } from '../../utils/mcp-logger.js';

/** build-profile.json5 中的模块信息（与 ModuleInfoParse 的 BuildProfileModule 结构兼容）。 */
export interface ModuleInfo {
    name: string;
    srcPath: string;
    type?: string;
}

/** compile_commands.json 中的单条编译命令。 */
export interface CompileCommand {
    directory: string;
    command?: string;
    file?: string;
    output?: string;
}

/** 判断给定文件路径是否是 C/C++ 源/头文件（不含 .ipp/.ixx/.inl/.inc/.tpp 等辅助扩展名）。 */
export function isCppFile(filePath: string): boolean {
    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
    return [
        'c', 'cpp', 'cxx', 'cc', 'h', 'hpp', 'hxx', 'hh',
    ].includes(ext);
}

/** 判断单个目录条目是否包含 C++ 信号（.cxx 子目录、递归子目录含 C++、或自身是 C++ 文件）。 */
function entryHasCppSignal(modulePath: string, entry: fs.Dirent): boolean {
    const fullPath = path.join(modulePath, entry.name);
    if (entry.isDirectory()) {
        return entry.name === '.cxx' || hasCppFiles(fullPath);
    }
    return isCppFile(fullPath);
}

/** 递归检查目录是否包含 C++ 文件或 .cxx 子目录。 */
export function hasCppFiles(modulePath: string): boolean {
    if (!fs.existsSync(modulePath)) {
        return false;
    }
    try {
        const entries = fs.readdirSync(modulePath, { withFileTypes: true });
        return entries.some((entry) => entryHasCppSignal(modulePath, entry));
    } catch {
        // ignore permission errors
    }
    return false;
}

/** 查找项目中含有 C++ 文件的模块。 */
export function findCppModules(projectPath: string): ModuleInfo[] {
    try {
        const parser = new ModuleInfoParse(projectPath);
        const allModules = parser.getAllModuleInfo();
        const cppModules: ModuleInfo[] = [];
        for (const module of allModules) {
            const modulePath = path.resolve(projectPath, module.srcPath);
            if (hasCppFiles(modulePath)) {
                cppModules.push(module);
            }
        }
        return cppModules;
    } catch (err) {
        mcpLog.error(
            `[CppCompile] findCppModules threw: ${
                err instanceof Error ? err.message : String(err)
            }`,
        );
        throw err;
    }
}

/* ---------- compile_commands.json helpers ---------- */

/** 查找所有模块下的 compile_commands.json 文件。 */
function findCompileCommandsFiles(projectPath: string): string[] {
    const results: string[] = [];
    const parser = new ModuleInfoParse(projectPath);
    const modules = parser.getAllModuleInfo();

    for (const module of modules) {
        const modulePath = path.resolve(projectPath, module.srcPath);
        const cxxPath = path.join(modulePath, '.cxx');

        if (!fs.existsSync(cxxPath)) {
            continue;
        }

        findCompileCommandsRecursive(cxxPath, results);
    }

    return results;
}

/** 递归查找目录下的 compile_commands.json 文件。 */
function findCompileCommandsRecursive(dir: string, results: string[]): void {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                findCompileCommandsRecursive(fullPath, results);
            } else if (entry.name === 'compile_commands.json') {
                results.push(fullPath);
            }
        }
    } catch {
        // ignore permission errors
    }
}

/** 合并多个 compile_commands.json 文件的内容。 */
function mergeCompileCommands(files: string[]): CompileCommand[] {
    const merged: CompileCommand[] = [];
    for (const filePath of files) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const parsed = JSON.parse(content) as CompileCommand[];
            merged.push(...parsed);
        } catch {
            // skip invalid files
        }
    }
    return merged;
}

/** 将合并后的 compile_commands 写入标准位置。 */
function writeCompileCommands(projectPath: string, commands: CompileCommand[]): void {
    const targetDir = path.join(projectPath, ...COMPILE_COMMANDS_RELATIVE_SEGMENTS.slice(0, -1));
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, 'compile_commands.json');
    fs.writeFileSync(targetPath, JSON.stringify(commands, null, 2), 'utf8');
}

/** 查找所有模块下的 compile_commands.json 并合并写入。 */
export function findAndMergeCompileCommands(projectPath: string): void {
    const compileCommandsFiles = findCompileCommandsFiles(projectPath);

    if (compileCommandsFiles.length > 0) {
        const merged = mergeCompileCommands(compileCommandsFiles);
        writeCompileCommands(projectPath, merged);
        mcpLog.info(
            `[CppCompile] compile_commands.json generated, ${merged.length} compile commands`,
        );
    } else {
        mcpLog.warn('[CppCompile] No compile_commands.json files found');
    }
}

/* ---------- 文件覆盖检查 ---------- */

/** 构建被 compile_commands.json 覆盖的文件集合（用 realpath 规范化）。 */
export function buildCoveredFileSet(commands: CompileCommand[]): Set<string> {
    const coveredFiles = new Set<string>();
    for (const cmd of commands) {
        if (!cmd.file) {
            continue;
        }
        try {
            coveredFiles.add(fs.realpathSync(cmd.file));
        } catch {
            coveredFiles.add(cmd.file);
        }
    }
    return coveredFiles;
}

/** 检查单个文件是否被覆盖集合包含。 */
export function isFileCoveredBySet(file: string, coveredFiles: Set<string>): boolean {
    try {
        const canonical = fs.realpathSync(file);
        if (!coveredFiles.has(canonical)) {
            mcpLog.info(
                `[CppCompile] File not covered by compile_commands.json: ${file}`,
            );
            return false;
        }
    } catch {
        // file doesn't exist, will be caught by collectValidFiles
    }
    return true;
}

/** 检查待检查的 C++ 文件是否被 compile_commands.json 覆盖。返回 true 表示全部覆盖。 */
export function checkFilesCoveredByCompileCommands(
    compileCommandsPath: string,
    filesToCheck: string[],
): boolean {
    if (!fs.existsSync(compileCommandsPath)) {
        return false;
    }

    try {
        const content = fs.readFileSync(compileCommandsPath, 'utf8');
        const commands = JSON.parse(content) as CompileCommand[];
        const coveredFiles = buildCoveredFileSet(commands);
        for (const file of filesToCheck) {
            if (!isFileCoveredBySet(file, coveredFiles)) {
                return false;
            }
        }
        return true;
    } catch (err) {
        mcpLog.warn(`[CppCompile] Failed to read/parse compile_commands.json: ${err}`);
        return false;
    }
}

/* ---------- C++ project initialization (compileNative) ---------- */

/** compile_commands.json 的相对路径段（与 common.ts COMPILE_COMMANDS_RELATIVE_SEGMENTS 一致）。 */
const COMPILE_COMMANDS_RELATIVE_SEGMENTS = [
    '.idea',
    '.deveco',
    'cxx',
    'compile_commands.json',
] as const;

/**
 * 执行 compileNative 构建以生成 compile_commands.json。
 * node/hvigor 由启动期固定（ToolProvider 注入），不再从 sdkPath 派生。
 */
export async function runCompileNative(
    projectPath: string,
    sdkPath: string,
    nodePath: string,
    hvigorJsPath: string,
    cppModules: ModuleInfo[],
): Promise<void> {
    if (!hvigorJsPath) {
        mcpLog.warn(`[CppCompile] hvigorw.js path not injected (sdk '${sdkPath}')`);
        return;
    }
    mcpLog.info(`[CppCompile] sdkPath: ${sdkPath}, hvigorPath: ${hvigorJsPath}`);

    for (const module of cppModules) {
        const moduleName = module.name;
        try {
          CommonUtils.assertModuleName(moduleName);
        } catch {
          mcpLog.warn(`[CppCompile] Skipping module with invalid name: ${moduleName}`);
          continue;
        }
        const hvigorArgs = [
            '--mode', 'module',
            '-p', `module=${module.name}`,
            '-p', 'product=default',
            'compileNative',
            '--analyze=normal',
            '--parallel',
            '--incremental',
            '--no-daemon',
        ].join(' ');

        mcpLog.info(`[CppCompile] Running compileNative for module: ${module.name}`);

        const result = await executeBuildCommand(
            projectPath,
            nodePath,
            hvigorJsPath,
            sdkPath,
            hvigorArgs,
        );

        if (result.success) {
            mcpLog.info(`[CppCompile] compileNative ${module.name} succeeded`);
        } else {
            mcpLog.warn(`[CppCompile] compileNative ${module.name} failed: ${result.output}`);
        }
    }
}

/**
 * 完整的 C++ 工程初始化流程：
 * 1. 查找含 C++ 的模块
 * 2. 对每个模块执行 compileNative
 * 3. 合并 compile_commands.json
 */
export async function initializeCppProject(projectPath: string, sdkPath: string, nodePath: string, hvigorJsPath: string): Promise<void> {
    const cppModules = findCppModules(projectPath);

    if (cppModules.length === 0) {
        mcpLog.info('[CppCompile] No C++ modules found, skipping initialization');
        return;
    }

    mcpLog.info(
        `[CppCompile] Found ${cppModules.length} C++ module(s): ${cppModules.map((m) => m.name).join(', ')}`,
    );

    await runCompileNative(projectPath, sdkPath, nodePath, hvigorJsPath, cppModules);
    findAndMergeCompileCommands(projectPath);
}

/** 检查是否需要进行 C++ 初始化。返回 true 表示需要初始化，false 表示可以直接检查。 */
export function prepareCppCheck(projectPath: string, filesToCheck: string[]): boolean {
    const ccPath = compileCommandsPath(projectPath);

    // 1. compile_commands.json 不存在 → 需要初始化
    if (!fs.existsSync(ccPath)) {
        mcpLog.info('[CppCompile] compile_commands.json not found, needs initialization');
        return true;
    }

    // 2. 检查是否存在 cpp_modules
    const cppModules = findCppModules(projectPath);
    if (cppModules.length === 0) {
        mcpLog.info('[CppCompile] No cpp modules found, no initialization needed');
        return false;
    }

    // 3. 检查传入文件是否被 compile_commands.json 覆盖
    const covered = checkFilesCoveredByCompileCommands(ccPath, filesToCheck);
    if (!covered) {
        mcpLog.info('[CppCompile] Files not fully covered by compile_commands.json, needs initialization');
        return true;
    }

    mcpLog.info('[CppCompile] All files covered, no initialization needed');
    return false;
}
