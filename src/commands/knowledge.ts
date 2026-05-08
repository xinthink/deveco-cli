/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { red } from 'colorette';
import { Knowledge, normalizeBigSearchQuestion } from '../utils/knowledge';
import { loginService } from '../auth/login-service';

interface KnowledgeCliOptions {
  keywords: string | string[];
}

const knowledgeCommand = new Command('knowledge')
  .description('Search HarmonyOS app development knowledge (ArkTS / ArkUI / API usage, etc.)')
  .requiredOption(
    '--keywords <words...>',
    'HarmonyOS knowledge query: multiple words allowed without quotes (e.g. --keywords ArkTS Row 布局)',
  )
  .action(async (opts: KnowledgeCliOptions) => {
    if (!(await loginService.isLoggedIn())) {
      console.error(red('Please login first'));
      process.exitCode = 1;
      return;
    }
    try {
      const content = normalizeBigSearchQuestion(opts.keywords);
      if (!content) {
        console.error(red('content is empty after normalization'));
        process.exitCode = 1;
        return;
      }
      const result = await Knowledge.getInstance().getBigSearchResponse(content);
      if (!result.ok) {
        process.exitCode = 1;
        return;
      }
      const { ranked: topList } = result;
      const contentStrings = topList.map((item) => item.content);
      // 用 JSON.stringify 打印数组，避免 console.log(arr) 把含 \n 的字符串
      // 拆成 'a\n' + 'b' 的怪格式（util.inspect 默认行为）。
      console.log(JSON.stringify(contentStrings, null, 2));
    } catch (err) {
      const e = err as Error;
      console.error(red(e.message || String(err)));
      process.exitCode = 1;
    }
  });

export default knowledgeCommand;
