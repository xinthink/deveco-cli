/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command } from 'commander';
import { red, green } from 'colorette';
import { spawn, ChildProcess } from 'child_process';
import ora from 'ora';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { ToolProvider } from '../utils/tool-provider.js';
import { Project } from '../utils/project.js';
import { loadUiVerificationConfig } from '../utils/ui-verification-config.js';

interface VerifyOptions {
  testPlan: string;
  bundleName?: string;
  freshStart: boolean;
}

interface VerifyResult {
  success: boolean;
  reason: string;
  successPart: string;
  failPart: string;
  id: string;
}

const CACHE_DIR = path.join(os.tmpdir(), 'ui-verification', 'cache');

function resolveUiVerificationBin(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  while (true) {
    const candidate = path.join(
      dir,
      'node_modules',
      'ui-verification-mcp',
      'bin',
      'ui-verification-mcp.cjs'
    );
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    'ui-verification-mcp not found. Please run: npm install -g ui-verification-mcp'
  );
}

type PendingHandler = {
  resolve: (msg: Record<string, unknown>) => void;
  reject: (err: Error) => void;
};

class McpSession {
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, PendingHandler>();

  private constructor(private child: ChildProcess) {
    child.stdout!.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (!('id' in msg)) continue;
        const id = msg.id as number;
        const handler = this.pending.get(id);
        if (handler) {
          this.pending.delete(id);
          handler.resolve(msg);
        }
      }
    });

    child.on('error', (err) => {
      for (const handler of this.pending.values()) handler.reject(err);
      this.pending.clear();
    });

    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        const err = new Error(`ui-verification-mcp exited with code ${code}`);
        for (const handler of this.pending.values()) handler.reject(err);
        this.pending.clear();
      }
    });
  }

  private sendAndWait(id: number, msg: object): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin!.write(JSON.stringify(msg) + '\n');
    });
  }

  static async start(binPath: string, env: NodeJS.ProcessEnv): Promise<McpSession> {
    const child = spawn('node', [binPath], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const session = new McpSession(child);
    await session.sendAndWait(0, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'devecocli', version: '1.0.0' },
      },
    });
    return session;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.sendAndWait(id, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    if (response.error) {
      const err = response.error as Record<string, unknown>;
      throw new Error(String(err.message ?? `${name} failed`));
    }
    const result = response.result as Record<string, unknown>;
    if (result?.structuredContent != null) return result.structuredContent;
    const content = result?.content as Array<{ text: string }> | undefined;
    if (content && content.length > 0) return content[0].text;
    return result;
  }

  close(): void {
    this.child.kill();
  }
}
const MAX_CACHE_ENTRIES = 15;

function parseVerifyResult(raw: unknown): VerifyResult {
  if (typeof raw === 'object' && raw !== null) return raw as VerifyResult;
  if (typeof raw === 'string') return JSON.parse(raw) as VerifyResult;
  throw new Error('Failed to parse verifyUI result');
}

function pruneCache(cacheDir: string, maxEntries: number): void {
  if (!fs.existsSync(cacheDir)) return;
  const entries = fs.readdirSync(cacheDir)
    .map((name) => ({ name, mtime: fs.statSync(path.join(cacheDir, name)).mtime }))
    .sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
  for (const entry of entries.slice(0, Math.max(0, entries.length - maxEntries))) {
    fs.rmSync(path.join(cacheDir, entry.name), { recursive: true, force: true });
  }
}

const verifyCommand = new Command('verify')
  .description('Run UI intent verification on a HarmonyOS device')
  .requiredOption(
    '--test-plan <plan>',
    'Natural-language test plan describing steps and expected results'
  )
  .option('--bundle-name <name>', 'App bundle name (auto-detected from app.json5 if omitted)')
  .option('--no-fresh-start', 'Skip relaunching the app before verification')
  .allowExcessArguments(true)
  .action(async (options: VerifyOptions, cmd: Command) => {
    // PowerShell splits quoted strings containing \" into multiple argv entries.
    // Rejoin any excess positional arguments back into testPlan.
    const excess: string[] = cmd.args;
    if (excess.length > 0) {
      options = { ...options, testPlan: [options.testPlan, ...excess].join(' ') };
    }

    const config = loadUiVerificationConfig();
    if (!config || !config.baseUrl || !config.modelName || !config.apiKey) {
      const userMessage =
        'UI 意图校验暂不可用：未配置多模态模型。请运行 devecocli init --ui-base-url "your-url" --ui-model-name "your-model-name" --ui-api-key "your-api-key" 指令配置多模态模型后重试。';
      console.error(red(userMessage));
      console.log(
        JSON.stringify({
          success: false,
          reason: `UI 意图校验执行失败。请将以下内容原文告知用户，不要修改或补充，告知后立即停止，不要再调用任何工具：「${userMessage}」`,
        })
      );
      process.exit(1);
    }

    const spinner = ora('Verifying UI...').start();
    try {
      const toolProvider = await ToolProvider.new();
      const binPath = resolveUiVerificationBin();

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        UI_VERIFY_BASE_URL: config.baseUrl,
        UI_VERIFY_API_KEY: config.apiKey,
        UI_VERIFY_MODEL_NAME: config.modelName,
        UI_VERIFY_HDC_PATH: toolProvider.hdcPath,
      };

      let bundleName = options.bundleName ?? '';
      if (!bundleName) {
        try {
          bundleName = Project.discover(process.cwd()).getBundleName();
        } catch {
          // Not in a project directory; let ui-verification-mcp handle detection
        }
      }

      const session = await McpSession.start(binPath, env);
      let result: VerifyResult;
      try {
        const raw = await session.callTool('verifyUI', {
          testPlan: options.testPlan,
          bundleName,
          freshStart: options.freshStart,
        });
        result = parseVerifyResult(raw);

        // Persist log and screenshots in the same session before the process exits
        const entryDir = path.join(CACHE_DIR, result.id);
        const screenshotDir = path.join(entryDir, 'screenshots');
        fs.mkdirSync(screenshotDir, { recursive: true });

        try {
          const log = await session.callTool('getLog', { id: result.id, maxLogSize: -1 });
          fs.writeFileSync(path.join(entryDir, 'verify.log'), String(log), 'utf-8');
        } catch {
          // log collection failure should not fail the verify command
        }

        try {
          await session.callTool('saveScreenshot', { id: result.id, dirname: screenshotDir });
        } catch {
          // screenshot collection failure should not fail the verify command
        }

        pruneCache(CACHE_DIR, MAX_CACHE_ENTRIES);
      } finally {
        session.close();
      }

      if (result.success) {
        spinner.succeed(green('Verification passed'));
      } else {
        spinner.fail(red('Verification failed'));
      }
      console.log(JSON.stringify(result, null, 2));

      if (!result.success) {
        process.exitCode = 1;
      }
    } catch (error) {
      spinner.fail(red((error as Error).message));
      process.exit(1);
    }
  });

export const verifyLogCommand = new Command('verify-log')
  .description('Get verification log by ID')
  .requiredOption('--id <id>', 'Verification task ID')
  .option('--search-keywords <keywords>', 'Filter log by keywords')
  .option('--max-log-size <n>', 'Max characters to show (-1 for unlimited)', '5000')
  .action((opts: { id: string; searchKeywords?: string; maxLogSize: string }) => {
    const logFile = path.join(CACHE_DIR, opts.id, 'verify.log');
    if (!fs.existsSync(logFile)) {
      console.error(red(`No log found for ID: ${opts.id}`));
      process.exit(1);
    }
    let log = fs.readFileSync(logFile, 'utf-8');

    if (opts.searchKeywords) {
      const filtered = log
        .split('\n')
        .filter((l) => l.includes(opts.searchKeywords!))
        .map((l) => l + '\n')
        .join('');
      if (!filtered) {
        console.log(`The log does not contain the keyword '${opts.searchKeywords}.`);
        return;
      }
      log = filtered;
    }

    const maxSize = parseInt(opts.maxLogSize, 10);
    if (maxSize === -1 || log.length < maxSize) {
      // no truncation
    } else if (maxSize < 0) {
      console.log('Please enter the correct maxLogSize');
      return;
    } else {
      log =
        `(exceeded log size limit, showing last ${maxSize} characters)...\n` +
        log.slice(-maxSize);
    }

    console.log(log);
  });

export const verifyScreenshotCommand = new Command('verify-screenshot')
  .description('Save verification screenshots by ID')
  .requiredOption('--id <id>', 'Verification task ID')
  .requiredOption('--save-path <path>', 'Absolute path to save screenshots')
  .action((opts: { id: string; savePath: string }) => {
    const srcDir = path.join(CACHE_DIR, opts.id, 'screenshots');
    if (!fs.existsSync(srcDir)) {
      console.error(red(`No screenshots found for ID: ${opts.id}`));
      process.exit(1);
    }
    fs.mkdirSync(opts.savePath, { recursive: true });
    const files = fs.readdirSync(srcDir);
    const copied = files.map((f) => {
      const dest = path.join(opts.savePath, f);
      fs.copyFileSync(path.join(srcDir, f), dest);
      return dest;
    });
    console.log(
      JSON.stringify({ filenames: copied, message: 'Screenshots saved successfully' }, null, 2)
    );
  });

export default verifyCommand;
