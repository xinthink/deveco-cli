/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

/**
 * 验证 skill 名称是否安全。仅限字母、数字、点、下划线和连字符。
 * 使用白名单正则校验，防止路径穿越攻击
 * @param name - skill 名称
 * @throws 如果名称不安全
 */
export function assertSafeSkillName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Unsafe skill name: ${JSON.stringify(name)}`);
  }
}
