/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import fs from 'fs-extra';
import { execaCommand } from 'execa';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_TEMP_PATH = path.join(__dirname, '../SKILL_TEMP.md');
const SKILL_MD_PATH = path.join(__dirname, '../SKILL.md');
const CLI_PATH = path.join(__dirname, '../dist/cli.js');

async function updateSkillDocs() {
  if (!fs.existsSync(CLI_PATH)) {
    console.error(`CLI not found at ${CLI_PATH}. Please build the project first.`);
    process.exit(1);
  }

  if (!fs.existsSync(SKILL_TEMP_PATH)) {
    console.error(`Template not found at ${SKILL_TEMP_PATH}.`);
    process.exit(1);
  }

  let skillMdContent = await fs.readFile(SKILL_TEMP_PATH, 'utf-8');

  // Match blocks like: <!-- EXEC_START: command --> ... <!-- EXEC_END -->
  const regex = /<!--\s*EXEC_START:\s*(.+?)\s*-->([\s\S]*?)<!--\s*EXEC_END\s*-->/g;
  const matches = [...skillMdContent.matchAll(regex)];

  if (matches.length === 0) {
    console.log('No EXEC_START placeholders found in SKILL_TEMP.md.');
  } else {
    for (const match of matches) {
      const fullMatch = match[0];
      const command = match[1].trim();

      try {
        console.log(`Executing: ${command}`);
        const { stdout } = await execaCommand(command, {
          cwd: path.join(__dirname, '..'),
          shell: true
        });

        const newBlock = `\`\`\`text\n${stdout}\n\`\`\``;
        skillMdContent = skillMdContent.replace(fullMatch, newBlock);
      } catch (err) {
        console.error(`Failed to execute command: ${command}`);
        console.error(err);
        process.exit(1);
      }
    }
  }

  await fs.writeFile(SKILL_MD_PATH, skillMdContent, 'utf-8');
  console.log('Successfully generated SKILL.md from SKILL_TEMP.md with latest command outputs.');
}

updateSkillDocs().catch(err => {
  console.error('Failed to generate SKILL.md:', err);
  process.exit(1);
});
