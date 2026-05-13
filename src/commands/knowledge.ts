/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { red } from 'colorette';
import { Knowledge } from '../utils/knowledge.js';
import { loginService } from '../auth/login-service.js';

type OutputFormat = 'md' | 'markdown' | 'json';

interface KnowledgeCliOptions {
  prompt: string;
  format: OutputFormat;
}

const knowledgeCommand = new Command('knowledge')
  .description(
    'Search the HarmonyOS knowledge (ArkTS / ArkUI / API usage, etc.)'
  )
  .requiredOption(
    '--prompt <question>',
    'Search terms, e.g. --prompt "What is the use of context?"'
  )
  .option(
    '--format <fmt>',
    'Output format: md, markdown, json',
    'md'
  )
  .action(async (opts: KnowledgeCliOptions) => {
    if (!(await loginService.isLoggedIn())) {
      console.error(red('Please login first'));
      process.exit(1);
    }
    const validFormats: OutputFormat[] = ['md', 'markdown', 'json'];
    if (!validFormats.includes(opts.format)) {
      console.error(red(`Invalid format "${opts.format}". Allowed: md, markdown, json`));
      process.exit(1);
    }
    try {
      const prompt = opts.prompt.trim();
      if (!prompt) {
        console.error(red('prompt is empty'));
        process.exit(1);
      }

      const result =
        await Knowledge.getInstance().getBigSearchResponse(opts.prompt);
      if (!result.ok) {
        process.exit(1);
      }
      const { ranked: topList } = result;
      if (opts.format === 'json') {
        process.stdout.write('[\n');
        topList.forEach((item, i) => {
          process.stdout.write(JSON.stringify(item.content));
          if (i < topList.length - 1) {
            process.stdout.write(',\n');
          }
        });
        process.stdout.write('\n]\n');
      } else {
        for (const item of topList) {
          process.stdout.write(item.content + '\n\n---\n\n');
        }
      }
    } catch (err) {
      console.error(red((err as Error).message || String(err)));
      process.exit(1);
    }
  });

export default knowledgeCommand;
