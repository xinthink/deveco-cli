/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { AGENT_SKILLS_CONFIG, SkillsApiConstants } from '../config/constants';
import { httpClient } from '../utils/http-client';
import { SkillOperationResult } from '../types/skills';

const fsp = fs.promises;

/**
 * 验证 skill 名称是否安全。仅限字母、数字、点、下划线和连字符。
 * 使用白名单正则校验，防止路径穿越攻击
 * @param name - skill 名称
 * @throws 如果名称不安全
 */
function assertSafeSkillName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Unsafe skill name: ${JSON.stringify(name)}`);
  }
}

/**
 * 验证路径是否在指定父目录内
 * 防止 zip slip 和路径穿越攻击
 * @param parent - 父目录路径
 * @param child - 待验证的子路径
 * @throws 如果路径越界
 */
function assertWithin(parent: string, child: string): void {
  const resolved = path.resolve(child);
  const root = path.resolve(parent);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escape detected: ${child}`);
  }
}

/**
 * 解析路径为绝对路径
 * 支持相对路径（基于 process.cwd()）和绝对路径
 * @param pathToResolve - 待解析的路径（相对或绝对）
 * @returns 解析后的绝对路径
 */
export function resolvePath(pathToResolve: string): string {
  return path.isAbsolute(pathToResolve)
    ? pathToResolve
    : path.resolve(process.cwd(), pathToResolve);
}

/**
 * 下载 Skill 的 zip 文件
 * 通过 API 下载指定 skill 的 zip 压缩包
 * @param skillName - skill 的英文名称
 * @returns zip 文件的 Buffer
 * @throws 如果下载失败或 skill 不存在
 */
export async function downloadSkill(skillName: string): Promise<Buffer> {
  // 构建 API URL
  const url = `${SkillsApiConstants.SKILL_INSTALL_API_BASE}/${skillName}/install?format=zip`;
  // 使用 httpClient.getBinary 下载
  const buffer = await httpClient.getBinary(url);

  return buffer;
}

/**
 * 解压技能 zip 文件到指定目录
 * @param zipBuffer - zip 文件的 Buffer 数据
 * @param targetDir - 目标目录路径
 * @param skillName - 技能名称，用于创建子目录
 */
export async function extractSkill(
  zipBuffer: Buffer,
  targetDir: string,
  skillName: string
): Promise<void> {
  // 验证 skill 名称安全性
  assertSafeSkillName(skillName);

  // 创建 zip 实例
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

  // 确保目标目录存在
  try {
    await fsp.stat(targetDir);
  } catch {
    await fsp.mkdir(targetDir, { recursive: true });
  }

  // 解压到 {targetDir}/{skillName}/ 目录
  const extractPath = path.join(targetDir, skillName);

  // 验证解压路径边界
  assertWithin(targetDir, extractPath);

  // 解压前遍历 zip 条目，逐一校验路径安全性
  for (const entry of entries) {
    const dest = path.join(extractPath, entry.entryName);
    assertWithin(extractPath, dest);
  }

  zip.extractAllTo(extractPath, true);
}

/**
 * 检查 agent 是否存在
 * 检查指定的 agent 是否在配置中，以及其根目录是否存在
 * @param agentName - agent 名称（如 'claude', 'opencode' 等）
 * @returns 如果 agent 在配置中且根目录存在则返回 true，否则返回 false
 */
export async function checkAgentExists(agentName: string): Promise<boolean> {
  // 检查 agent 是否在配置中
  const agentConfig =
    AGENT_SKILLS_CONFIG[agentName as keyof typeof AGENT_SKILLS_CONFIG];

  if (!agentConfig) {
    throw new Error(
      `Invalid agent: ${agentName}, Valid options are: ${Object.keys(AGENT_SKILLS_CONFIG).join(', ')}`
    );
  }

  // 构建 agent 根目录路径（移除 '/skills' 后缀）
  const agentRootPath = path.join(
    homedir(),
    agentConfig.path.replace('/skills', '')
  );

  // 检查目录是否存在
  try {
    await fsp.access(agentRootPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取 agent 的 skills 目录路径
 */
function getAgentSkillsDir(agentName: string): string {
  const agentConfig =
    AGENT_SKILLS_CONFIG[agentName as keyof typeof AGENT_SKILLS_CONFIG];
  return path.join(homedir(), agentConfig.path);
}

/**
 * 获取项目下指定 agent 的 skills 目录路径
 */
function getProjectAgentSkillsDir(projectPath: string, agentName: string): string {
  return path.join(projectPath, '.' + agentName, 'skills');
}

/**
 * 准备技能安装目录
 * 检查已存在的情况，根据 force 参数决定是否删除
 * @returns 如果需要跳过安装则返回 true
 */
async function prepareSkillDirectory(
  skillsDir: string,
  skillName: string,
  force: boolean
): Promise<{ skillDir: string; shouldSkip: boolean }> {
  // 验证 skill 名称安全性
  assertSafeSkillName(skillName);

  const skillDir = path.join(skillsDir, skillName);

  try {
    await fsp.access(skillDir);
    if (force) {
      await fsp.rm(skillDir, { recursive: true, force: true });
    } else {
      console.log(`Skill ${skillName} exists in ${skillsDir}`);
      return { skillDir, shouldSkip: true };
    }
  } catch {
    // 目录不存在，继续安装
  }

  return { skillDir, shouldSkip: false };
}

/**
 * 执行技能安装（从 zip buffer）
 */
async function performSkillInstall(
  zipBuffer: Buffer,
  skillsDir: string,
  skillName: string
): Promise<void> {
  await extractSkill(zipBuffer, skillsDir, skillName);
  console.log(
    `Skill ${skillName} installed to ${path.join(skillsDir, skillName)}`
  );
}

/**
 * 把单个本地文件作为 skill 内容写入目标目录
 * 落盘路径：{skillsDir}/{skillName}/{basename(sourceFile)}
 */
async function performLocalSkillInstall(
  sourceFile: string,
  skillsDir: string,
  skillName: string
): Promise<void> {
  const skillDir = path.join(skillsDir, skillName);
  await fsp.mkdir(skillDir, { recursive: true });
  const target = path.join(skillDir, path.basename(sourceFile));
  await fsp.copyFile(sourceFile, target);
  console.log(`Skill ${skillName} installed to ${target}`);
}

/**
 * 统一的错误处理
 */
function handleOperationError(
  error: unknown,
  defaultErrMsg: string = ''
): SkillOperationResult {
  const errorMessage = error instanceof Error ? error.message : defaultErrMsg;
  return { success: false, error: errorMessage };
}

/**
 * 统一的安装执行器
 * @param skillName - 技能英文名称
 * @param getSkillsDir - 获取 skills 目录路径的函数
 * @param performInstall - 执行安装的函数
 * @param force - 是否强制重新安装
 * @param ensureSkillsDir - 是否需要确保 skillsDir 存在（用于项目 agent 场景）
 * @returns 安装结果
 */
async function executeInstall(
  skillName: string,
  getSkillsDir: () => string | Promise<string>,
  performInstall: (skillsDir: string) => Promise<void>,
  force: boolean,
  ensureSkillsDir: boolean = false
): Promise<SkillOperationResult> {
  try {
    const skillsDir = await getSkillsDir();

    if (ensureSkillsDir) {
      await fsp.mkdir(skillsDir, { recursive: true });
    }

    const { shouldSkip } = await prepareSkillDirectory(skillsDir, skillName, force);

    if (shouldSkip) {
      return { success: true, skipped: true };
    }

    await performInstall(skillsDir);
    return { success: true };
  } catch (error: unknown) {
    return handleOperationError(error, 'Installation failed');
  }
}

/**
 * 统一的移除执行器
 * @param skillName - 技能英文名称
 * @param getSkillsDir - 获取 skills 目录路径的函数
 * @returns 移除结果
 */
async function executeRemove(
  skillName: string,
  getSkillsDir: () => string | Promise<string>
): Promise<SkillOperationResult> {
  try {
    assertSafeSkillName(skillName);

    const skillsDir = await getSkillsDir();
    const skillDir = path.join(skillsDir, skillName);

    try {
      await fsp.access(skillDir);
    } catch {
      console.log(`Skill ${skillName} does not exist in ${skillsDir}`);
      return { success: true, skipped: true };
    }

    await fsp.rm(skillDir, { recursive: true, force: true });
    console.log(`Skill ${skillName} removed from ${skillDir}`);
    return { success: true };
  } catch (error: unknown) {
    return handleOperationError(error, 'Removal failed');
  }
}

/**
 * 使用已下载的 Buffer 安装技能到指定 agent
 * @param skillName - 技能英文名称
 * @param agentName - agent 名称
 * @param zipBuffer - 已下载的 zip Buffer
 * @param force - 是否强制重新安装（如果已存在则删除旧目录）
 * @returns 安装结果
 */
export async function installSkillToAgentWithBuffer(
  skillName: string,
  agentName: string,
  zipBuffer: Buffer,
  force: boolean = false
): Promise<SkillOperationResult> {
  return executeInstall(
    skillName,
    () => getAgentSkillsDir(agentName),
    (skillsDir) => performSkillInstall(zipBuffer, skillsDir, skillName),
    force
  );
}

/**
 * 安装技能到指定项目目录
 * @param skillName - 技能英文名称
 * @param zipBuffer - 已下载的 zip Buffer
 * @param customPath - 目录路径
 * @param force - 是否强制重新安装（如果已存在则删除旧目录）
 * @returns 安装结果
 */
export async function installSkillToPath(
  skillName: string,
  zipBuffer: Buffer,
  customPath: string,
  force: boolean = false
): Promise<SkillOperationResult> {
  return executeInstall(
    skillName,
    () => customPath,
    (skillsDir) => performSkillInstall(zipBuffer, skillsDir, skillName),
    force
  );
}

/**
 * 安装技能到项目下指定 agent 目录
 * @param skillName - 技能英文名称
 * @param zipBuffer - 已下载的 zip Buffer
 * @param projectPath - 项目根目录路径
 * @param agentName - agent 名称
 * @param force - 是否强制重新安装（如果已存在则删除旧目录）
 * @returns 安装结果
 */
export async function installSkillToProjectAgent(
  skillName: string,
  zipBuffer: Buffer,
  projectPath: string,
  agentName: string,
  force: boolean = false
): Promise<SkillOperationResult> {
  return executeInstall(
    skillName,
    () => getProjectAgentSkillsDir(projectPath, agentName),
    (skillsDir) => performSkillInstall(zipBuffer, skillsDir, skillName),
    force,
    true // 确保项目 agent skills 目录存在
  );
}

/**
 * 把本地 skill 文件安装到指定 agent
 * 与 installSkillToAgentWithBuffer 同语义，但不解压 zip，仅复制单个文件
 * @param skillName - 技能英文名称（同时作为子目录名）
 * @param sourceFile - 本地源文件绝对路径（如 SKILL.md）
 * @param agentName - agent 名称
 * @param force - 是否强制覆盖
 */
export async function installLocalSkillToAgent(
  skillName: string,
  sourceFile: string,
  agentName: string,
  force: boolean = false
): Promise<SkillOperationResult> {
  return executeInstall(
    skillName,
    () => getAgentSkillsDir(agentName),
    (skillsDir) => performLocalSkillInstall(sourceFile, skillsDir, skillName),
    force
  );
}

/**
 * 把本地 skill 文件安装到项目下指定 agent 目录
 * 与 installSkillToProjectAgent 同语义，但不解压 zip，仅复制单个文件
 * @param skillName - 技能英文名称（同时作为子目录名）
 * @param sourceFile - 本地源文件绝对路径（如 SKILL.md）
 * @param projectPath - 项目根目录路径
 * @param agentName - agent 名称
 * @param force - 是否强制覆盖
 */
export async function installLocalSkillToProjectAgent(
  skillName: string,
  sourceFile: string,
  projectPath: string,
  agentName: string,
  force: boolean = false
): Promise<SkillOperationResult> {
  return executeInstall(
    skillName,
    () => getProjectAgentSkillsDir(projectPath, agentName),
    (skillsDir) => performLocalSkillInstall(sourceFile, skillsDir, skillName),
    force,
    true // 确保项目 agent skills 目录存在
  );
}

/**
 * 把本地 skill 文件安装到指定自定义路径
 * 与 installSkillToPath 同语义，但不解压 zip，仅复制单个文件
 * @param skillName - 技能英文名称（同时作为子目录名）
 * @param sourceFile - 本地源文件绝对路径（如 SKILL.md）
 * @param customPath - 目标目录路径
 * @param force - 是否强制覆盖
 */
export async function installLocalSkillToPath(
  skillName: string,
  sourceFile: string,
  customPath: string,
  force: boolean = false
): Promise<SkillOperationResult> {
  return executeInstall(
    skillName,
    () => customPath,
    (skillsDir) => performLocalSkillInstall(sourceFile, skillsDir, skillName),
    force
  );
}

/**
 * 从指定 agent 移除技能
 * 删除技能目录，如果不存在则跳过
 * @param skillName - 技能英文名称
 * @param agentName - agent 名称
 * @returns 移除结果
 */
export async function removeSkillFromAgent(
  skillName: string,
  agentName: string
): Promise<SkillOperationResult> {
  return executeRemove(skillName, () => getAgentSkillsDir(agentName));
}

/**
 * 从指定项目目录移除技能
 * 删除技能目录，如果不存在则跳过
 * @param skillName - 技能英文名称
 * @param customPath - 项目根目录路径
 * @returns 移除结果
 */
export async function removeSkillFromPath(
  skillName: string,
  customPath: string
): Promise<SkillOperationResult> {
  return executeRemove(skillName, () => customPath);
}

/**
 * 从项目下指定 agent 目录移除技能
 * 删除技能目录，如果不存在则跳过
 * @param skillName - 技能英文名称
 * @param projectPath - 项目根目录路径
 * @param agentName - agent 名称
 * @returns 移除结果
 */
export async function removeSkillFromProjectAgent(
  skillName: string,
  projectPath: string,
  agentName: string
): Promise<SkillOperationResult> {
  return executeRemove(skillName, () =>
    getProjectAgentSkillsDir(projectPath, agentName)
  );
}

/**
 * 定位仓库内置的 SKILL.md 路径
 * 从当前模块目录向上查找首个包含 SKILL.md 的目录
 * - 开发态（tsx src/cli.ts）：src/skills/installer.ts -> 仓库根
 * - 构建产物（dist/cli.js）：dist/cli.js -> 包根
 * @returns SKILL.md 的绝对路径
 * @throws 未找到时抛出错误
 */
export function resolveBundledSkillMdPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;

  while (true) {
    const candidate = path.join(dir, 'SKILL.md');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  throw new Error(
    'SKILL.md not found in deveco-cli package; please reinstall deveco-cli.'
  );
}
