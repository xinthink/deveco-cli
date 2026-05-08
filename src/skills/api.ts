/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { httpClient } from '../utils/http-client';
import type { HttpResponse } from '../types/http';
import { SkillsApiConstants, AGENT_SKILLS_CONFIG } from '../config/constants';
import type { TagsResponse, SkillsResponse, Skill } from '../types/skills';

/**
 * 获取 HMOS 标签的 ID
 * 通过 Tags API 查询所有标签，返回 HMOS 标签的 ID
 * @returns HMOS 标签的 ID
 * @throws 如果 API 调用失败或找不到 HMOS 标签
 */
export async function fetchHmosTagId(): Promise<string> {
  // 调用 Tags API 获取标签列表
  const response = await httpClient.get(SkillsApiConstants.TAGS_API_URL);

  // 验证并解析响应
  const data = validateApiResponse<TagsResponse>(response, 'Tags API');

  // 在标签列表中查找 HMOS 标签
  const hmosTag = data.data.skill.find((tag) => tag.name === 'HMOS');

  if (!hmosTag) {
    throw new Error('HMOS tag not found');
  }

  return hmosTag.id;
}

/**
 * 获取所有技能（自动翻页）
 * 通过 Skills API 获取指定标签下的所有技能，自动处理分页
 * @param tagId - HMOS 标签的 ID
 * @returns 所有技能数组
 * @throws 如果 API 调用失败
 */
export async function fetchAllSkills(tagId: string): Promise<Skill[]> {
  const allSkills: Skill[] = [];
  let pageNum = 1;
  const pageSize = SkillsApiConstants.DEFAULT_PAGE_SIZE;

  // 循环获取每一页数据
  while (true) {
    // 发送 POST 请求
    const response = await httpClient.post(SkillsApiConstants.SKILLS_API_URL, {
      headers: {
        'Content-Type': 'application/json',
      },
      params: {
        pageNum,
        pageSize,
        tagIds: [tagId],
      },
    });

    // 验证并解析响应
    const data = validateApiResponse<SkillsResponse>(response, 'Skills API');

    // 将当前页的技能添加到结果数组
    allSkills.push(...data.data.list);

    // 如果当前页数据少于页大小，说明已经是最后一页
    if (data.data.list.length < pageSize) {
      break;
    }

    pageNum++;
  }

  return allSkills;
}

/**
 * 搜索技能
 * 通过 Skills API 搜索匹配关键词的技能
 * @param keyword - 搜索关键词
 * @param tagId - HMOS 标签的 ID
 * @returns 匹配的技能数组
 * @throws 如果 API 调用失败
 */
export async function searchSkills(
  keyword: string,
  tagId: string
): Promise<Skill[]> {
  // 发送 POST 请求
  const response = await httpClient.post(SkillsApiConstants.SKILLS_API_URL, {
    headers: {
      'Content-Type': 'application/json',
    },
    params: {
      pageNum: 1,
      pageSize: SkillsApiConstants.DEFAULT_PAGE_SIZE,
      keyword,
      tagIds: [tagId],
    },
  });

  // 验证并解析响应
  const data = validateApiResponse<SkillsResponse>(response, 'Skills API');

  return data.data.list;
}

/**
 * 获取已安装指定 skill 的 agent 列表
 * 遍历所有 agent 配置，检查每个 agent 的 skills 目录下是否存在指定的 skill
 * @param skillName - skill 名称
 * @returns 已安装该 skill 的 agent 显示名称数组（按字母排序）
 */
export function getInstalledAgents(skillName: string): string[] {
  const installedAgents: string[] = [];

  // 遍历所有 agent 配置
  for (const [, agentConfig] of Object.entries(AGENT_SKILLS_CONFIG)) {
    // 构建完整的 skill 路径
    const skillPath = path.join(homedir(), agentConfig.path, skillName);

    // 检查该路径是否存在
    if (fs.existsSync(skillPath)) {
      installedAgents.push(agentConfig.displayName);
    }
  }

  // 按字母排序后返回
  return installedAgents.sort();
}

/**
 * API 响应基础接口
 * 所有 API 响应都应包含 code 和 message 字段
 */
interface ApiResponseBase {
  code: string;
  message: string;
}

/**
 * 验证 API 响应
 * 统一处理 HTTP 状态码检查和业务响应码检查
 * @param response HTTP 响应
 * @param apiName API 名称（用于错误消息）
 * @returns 解析后的 JSON 数据
 * @throws 如果 HTTP 状态码或业务响应码不符合预期
 */
export function validateApiResponse<T extends ApiResponseBase>(
  response: HttpResponse,
  apiName: string
): T {
  // 检查 HTTP 响应状态
  if (response.statusCode !== 200) {
    throw new Error(`${apiName} Request failed: HTTP ${response.statusCode}`);
  }

  // 解析响应数据
  const data: T = httpClient.parseJson<T>(response);

  // 检查业务响应码
  if (data.code !== SkillsApiConstants.SUCCESS_CODE) {
    throw new Error(
      `${apiName} Error returned: ${data.code} - ${data.message}`
    );
  }

  return data;
}
