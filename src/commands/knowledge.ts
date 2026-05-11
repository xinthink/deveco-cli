/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { red } from 'colorette';
import { Knowledge, normalizeBigSearchQuestion } from '../utils/knowledge.js';
import { loginService } from '../auth/login-service.js';

interface KnowledgeCliOptions {
  keywords: string | string[];
}

const knowledgeCommand = new Command('knowledge')
  .description(
    'Search the HarmonyOS knowledge (ArkTS / ArkUI / API usage, etc.)'
  )
  .requiredOption(
    '--keywords <words...>',
    'Search terms, e.g. --keywords ArkTS Row layout'
  )
  .action(async (opts: KnowledgeCliOptions) => {
    if (!(await loginService.isLoggedIn())) {
      console.error(red('Please login first'));
      process.exit(1);
    }
    try {
      const content = normalizeBigSearchQuestion(opts.keywords);
      if (!content) {
        console.error(red('Keywords are empty after normalization'));
        process.exit(1);
      }
      const result =
        await Knowledge.getInstance().getBigSearchResponse(content);
      if (!result.ok) {
        process.exit(1);
      }
      const { ranked: topList } = result;
      const contentStrings = topList.map((item) => item.content);
      // 用 JSON.stringify 打印数组，避免 console.log(arr) 把含 \n 的字符串
      // 拆成 'a\n' + 'b' 的怪格式（util.inspect 默认行为）。
      console.log(JSON.stringify(contentStrings, null, 2));
    } catch (err) {
      console.error(red((err as Error).message || String(err)));
      process.exit(1);
    }
  });

export default knowledgeCommand;
