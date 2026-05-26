/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * Skills API 常量
 */
export const SkillsApiConstants = {
  /** Tags API 端点（获取技能标签列表） */
  TAGS_API_URL:
    'https://matrix.openharmony.cn/api/model_base/model/tags?serviceType=skill',
  /** Skills API 端点（获取技能列表） */
  SKILLS_API_URL: 'https://matrix.openharmony.cn/api/registry/skill/skills',
  /** Skill 安装 API 基础路径 */
  SKILL_INSTALL_API_BASE: 'https://matrix.openharmony.cn/api/registry/skill',
  /** Skill Checksum API 基础路径 */
  SKILL_CHECKSUM_API_BASE: 'https://matrix.openharmony.cn/api/registry/skill',
  /** 默认分页大小 */
  DEFAULT_PAGE_SIZE: 20,
  /** 成功响应码 */
  SUCCESS_CODE: '20000',
} as const;

/**
 * Agent Skills 配置常量
 * 定义各 agent 的 skills 目录路径和显示名称
 */
export const AGENT_SKILLS_CONFIG = {
  'trae-cn': {
    path: '.trae-cn/skills',
    displayName: 'trae-cn',
  },
  opencode: {
    path: '.config/opencode/skills',
    displayName: 'opencode',
  },
  cursor: {
    path: '.cursor/skills',
    displayName: 'cursor',
  },
  codebuddy: {
    path: '.codebuddy/skills',
    displayName: 'codebuddy',
  },
  qoder: {
    path: '.qoder/skills',
    displayName: 'qoder',
  },
} as const;