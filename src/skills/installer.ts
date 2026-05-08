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
 * 下载缓存
 * 避免同一 skill 重复下载
 */
const downloadCache = new Map<string, Buffer>();

/**
 * 下载 Skill 的 zip 文件
 * 通过 API 下载指定 skill 的 zip 压缩包
 * @param skillName - skill 的英文名称
 * @returns zip 文件的 Buffer
 * @throws 如果下载失败或 skill 不存在
 */
export async function downloadSkill(skillName: string): Promise<Buffer> {
  // 检查缓存
  const cached = downloadCache.get(skillName);
  if (cached) {
    return cached;
  }

  // 构建 API URL
  const url = `${SkillsApiConstants.SKILL_INSTALL_API_BASE}/${skillName}/install?format=zip`;
  // 使用 httpClient.getBinary 下载
  const buffer = await httpClient.getBinary(url);

  // 存入缓存
  downloadCache.set(skillName, buffer);

  return buffer;
}

/**
 * 清理下载缓存
 * 在所有安装完成后调用，释放内存
 */
export function clearDownloadCache(): void {
  downloadCache.clear();
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
  // 创建 zip 实例
  const zip = new AdmZip(zipBuffer);

  // 确保目标目录存在
  await fsp.mkdir(targetDir, { recursive: true });

  // 解压到 {targetDir}/{skillName}/ 目录
  const extractPath = path.join(targetDir, skillName);
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
 * 获取项目的 skills 目录路径
 */
function getProjectSkillsDir(projectPath: string): string {
  return path.join(projectPath, 'skills');
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
 * 执行技能安装
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
 * 统一的错误处理
 */
function handleOperationError(error: unknown, defaultErrMsg: string = ''): SkillOperationResult {
  const errorMessage =
    error instanceof Error ? error.message : defaultErrMsg;
  return { success: false, error: errorMessage };
}

/**
 * 使用已下载的 Buffer 安装技能到指定 agent
 * 避免重复下载，配合 downloadSkill 缓存使用
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
  try {
    const skillsDir = getAgentSkillsDir(agentName);
    const { shouldSkip } = await prepareSkillDirectory(
      skillsDir,
      skillName,
      force
    );

    if (shouldSkip) {
      return { success: true, skipped: true };
    }

    await performSkillInstall(zipBuffer, skillsDir, skillName);
    return { success: true };
  } catch (error: unknown) {
    return handleOperationError(error, 'Installation failed');
  }
}

/**
 * 安装技能到指定项目目录
 * @param skillName - 技能英文名称
 * @param zipBuffer - 已下载的 zip Buffer
 * @param projectPath - 项目根目录路径
 * @param force - 是否强制重新安装（如果已存在则删除旧目录）
 * @returns 安装结果
 */
export async function installSkillToProject(
  skillName: string,
  zipBuffer: Buffer,
  projectPath: string,
  force: boolean = false
): Promise<SkillOperationResult> {
  try {
    const skillsDir = getProjectSkillsDir(projectPath);
    await fsp.mkdir(skillsDir, { recursive: true });

    const { shouldSkip } = await prepareSkillDirectory(
      skillsDir,
      skillName,
      force
    );

    if (shouldSkip) {
      return { success: true, skipped: true };
    }

    await performSkillInstall(zipBuffer, skillsDir, skillName);
    return { success: true };
  } catch (error: unknown) {
    return handleOperationError(error, 'Installation failed');
  }
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
  try {
    const agentConfig =
      AGENT_SKILLS_CONFIG[agentName as keyof typeof AGENT_SKILLS_CONFIG];

    const skillsDir = path.join(homedir(), agentConfig.path);
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
  try {
    const skillsDir = getAgentSkillsDir(agentName);
    const { shouldSkip } = await prepareSkillDirectory(
      skillsDir,
      skillName,
      force
    );

    if (shouldSkip) {
      return { success: true, skipped: true };
    }

    await performLocalSkillInstall(sourceFile, skillsDir, skillName);
    return { success: true };
  } catch (error: unknown) {
    return handleOperationError(error);
  }
}

/**
 * 把本地 skill 文件安装到指定项目目录
 * 与 installSkillToProject 同语义，但不解压 zip，仅复制单个文件
 */
export async function installLocalSkillToProject(
  skillName: string,
  sourceFile: string,
  projectPath: string,
  force: boolean = false
): Promise<SkillOperationResult> {
  try {
    const skillsDir = getProjectSkillsDir(projectPath);
    await fsp.mkdir(skillsDir, { recursive: true });

    const { shouldSkip } = await prepareSkillDirectory(
      skillsDir,
      skillName,
      force
    );

    if (shouldSkip) {
      return { success: true, skipped: true };
    }

    await performLocalSkillInstall(sourceFile, skillsDir, skillName);
    return { success: true };
  } catch (error: unknown) {
    return handleOperationError(error);
  }
}

/**
 * 从指定项目目录移除技能
 * 删除技能目录，如果不存在则跳过
 * @param skillName - 技能英文名称
 * @param projectPath - 项目根目录路径
 * @returns 移除结果
 */
export async function removeSkillFromProject(
  skillName: string,
  projectPath: string
): Promise<SkillOperationResult> {
  try {
    // 构建 skills 目录路径
    const skillsDir = path.join(projectPath, 'skills');
    const skillDir = path.join(skillsDir, skillName);

    // 如果 skill 目录不存在，返回 skipped
    try {
      await fsp.access(skillDir);
    } catch {
      console.log(`Skill ${skillName} does not exist in ${skillsDir}`);
      return { success: true, skipped: true };
    }

    // 删除 skill 目录
    await fsp.rm(skillDir, { recursive: true, force: true });
    console.log(`Skill ${skillName} removed from ${skillDir}`);
    return { success: true };
  } catch (error: unknown) {
    return handleOperationError(error, 'Removal failed');
  }
}
