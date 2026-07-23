/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { red, yellow } from 'colorette';
import { Argument, Command, InvalidArgumentError } from 'commander';
import fs from 'fs';
import * as path from 'path';
import { ToolProvider } from '../toolchain/index.js';
import { SpinnerHelper } from '../utils/spinner-helper.js';
import { CodelinterAdapter } from './codelinter-adapter.js';
import {
  formatJsonReport,
  formatMarkdownReport,
  formatTerminalPreview,
  formatTerminalSavedReport,
} from './report-renderer.js';
import type {
  CodelinterCheckRequest,
  CodelinterCheckResult,
  CodelinterReport,
  CodelinterReportFormat,
} from './types.js';
/** 先校验十进制数字形式，是否大于零由 parseLimit 继续判断。 */
const POSITIVE_INTEGER_PATTERN = /^\d+$/;

interface LintOptions {
  fix?: boolean;
  incremental?: boolean;
  configPath?: string;
  product: string;
  format: CodelinterReportFormat;
  limit?: number;
  outputPath?: string;
}

/** 创建并配置 Code Linter 子命令。 */
export function createLintCommand(): Command {
  return new Command('lint')
    .description('Run DevEco Code Linter checks for TS/ArkTS code')
    .helpOption('--help', 'display help for command')
    .addArgument(
      new Argument('[path]', 'File or directory to lint').argParser(
        parseLintPath
      )
    )
    .option('--fix', 'Auto-fix fixable code issues')
    .option('--incremental', 'Only check uncommitted files')
    .option(
      '--config-path <path>',
      'Path to lint configuration file',
      parseConfigPath
    )
    .option(
      '--product <product>',
      'Product name defined in build-profile.json5',
      parseProduct,
      'default'
    )
    .option(
      '--format <format>',
      'Report format (choices: default, json)',
      parseLintFormat,
      'default'
    )
    .option(
      '--output-path <path>',
      'Complete report file or directory',
      parseOutputPath
    )
    .option(
      '--limit <number>',
      'Maximum terminal issues to display when --output-path is omitted',
      parseLimit
    )
    .action(async (lintPath: string | undefined, options: LintOptions) => {
      await handleLintCommand(lintPath, options);
    });
}

function parseLintFormat(value: string): CodelinterReportFormat {
  if (value === 'default' || value === 'json') {
    return value;
  }
  throw new InvalidArgumentError(
    'Invalid --format. Expected one of: default, json.'
  );
}

function parseConfigPath(value: string): string {
  assertSafePathValue(value, '--config-path');
  const extension = path.extname(value).toLowerCase();
  if (extension !== '.json' && extension !== '.json5') {
    throw new InvalidArgumentError(
      '`--config-path` must point to a .json or .json5 file.'
    );
  }
  return value;
}

function parseProduct(value: string): string {
  assertSafeTextValue(value, 'product');
  return value;
}

function parseOutputPath(value: string): string {
  assertSafePathValue(value, '--output-path');
  return value;
}

function parseLintPath(value: string): string {
  assertSafePathValue(value, 'path');
  return value;
}

function parseLimit(value: string): number {
  assertSafeTextValue(value, 'limit');
  if (!POSITIVE_INTEGER_PATTERN.test(value)) {
    throw new InvalidArgumentError('`--limit` must be a positive integer.');
  }
  const limit = Number.parseInt(value, 10);
  if (limit <= 0 || !Number.isSafeInteger(limit)) {
    throw new InvalidArgumentError(
      '`--limit` must be an integer greater than 0.'
    );
  }
  return limit;
}

function assertSafeTextValue(value: string, fieldName: string): void {
  if (value.trim().length === 0 || hasControlCharacter(value)) {
    throw new InvalidArgumentError(`Invalid --${fieldName} value.`);
  }
}

function assertSafePathValue(value: string, fieldName: string): void {
  const label = `\`${fieldName}\``;
  if (value.length === 0 || hasControlCharacter(value)) {
    throw new InvalidArgumentError(
      `${label} must be a non-empty path without control characters.`
    );
  }
}

async function handleLintCommand(
  lintPath: string | undefined,
  options: LintOptions
): Promise<void> {
  const cwd = process.cwd();
  const reportPath = resolveReportPath(options.outputPath, options.format, cwd);
  if (options.fix) {
    console.warn(
      yellow(
        'Running codelinter with --fix. Ensure your project source is trusted.'
      )
    );
  }

  const result = await executeLint(lintPath, options, cwd);
  writeTextToStderr(result.diagnostics);
  process.exitCode = writeLintResult(
    result,
    reportPath,
    options.format,
    options.limit,
    cwd
  );
}

async function executeLint(
  lintPath: string | undefined,
  options: LintOptions,
  cwd: string
): Promise<CodelinterCheckResult> {
  const toolProvider = await ToolProvider.new();
  const adapter = new CodelinterAdapter(toolProvider, cwd);
  return runWithCheckingSpinner(adapter, {
    lintPath,
    configPath: options.configPath,
    product: options.product,
    fix: options.fix,
    incremental: options.incremental,
  });
}

async function runWithCheckingSpinner(
  adapter: CodelinterAdapter,
  request: CodelinterCheckRequest
): Promise<CodelinterCheckResult> {
  const spinner = new SpinnerHelper();
  if (process.stderr.isTTY) {
    spinner.start('Checking code...');
  }
  try {
    const result = await adapter.check(request);
    spinner.stop();
    return result;
  } catch (error) {
    spinner.fail('Code check failed');
    throw error;
  }
}

function writeLintResult(
  result: CodelinterCheckResult,
  reportPath: string | undefined,
  format: CodelinterReportFormat,
  limit: number | undefined,
  cwd: string
): number {
  if (!result.report) {
    console.error(red('Failed to generate Code Linter report.'));
    console.error(
      red(
        result.reportError?.message ?? 'Native JSON report was not generated.'
      )
    );
    return result.exitCode === 0 ? 1 : result.exitCode;
  }

  try {
    if (reportPath) {
      writeCompleteReport(reportPath, format, result.report);
      const displayPath = formatDisplayPath(reportPath, cwd);
      process.stdout.write(
        formatTerminalSavedReport(result.report, displayPath)
      );
    } else {
      process.stdout.write(formatTerminalPreview(result.report, limit));
    }
    return result.exitCode;
  } catch (error) {
    console.error(red('Failed to generate Code Linter report.'));
    console.error(red((error as Error).message));
    return result.exitCode === 0 ? 1 : result.exitCode;
  }
}

function writeCompleteReport(
  reportPath: string,
  format: CodelinterReportFormat,
  report: CodelinterReport
): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const content =
    format === 'json' ? formatJsonReport(report) : formatMarkdownReport(report);
  try {
    fs.writeFileSync(reportPath, content, {
      encoding: 'utf-8',
      flag: 'wx',
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Output file already exists: ${reportPath}`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** 解析并校验报告文件路径，目录输出时生成时间戳文件名。 */
function resolveReportPath(
  output: string | undefined,
  format: CodelinterReportFormat,
  cwd: string
): string | undefined {
  if (!output) {
    return undefined;
  }
  const resolvedOutput = resolveOutputPath(output, cwd);
  const directoryOutput = isDirectoryOutput(output, resolvedOutput);
  const reportPath = directoryOutput
    ? path.join(resolvedOutput, createTimestampReportName(format))
    : resolvedOutput;
  if (!directoryOutput) {
    validateReportExtension(output, format);
  }
  if (fs.existsSync(reportPath)) {
    throw new InvalidArgumentError(
      `Output file already exists: ${formatDisplayPath(reportPath, cwd)}`
    );
  }
  return reportPath;
}

function validateReportExtension(
  output: string,
  format: CodelinterReportFormat
): void {
  const expected = getReportExtension(format);
  if (path.extname(output).toLowerCase() !== expected) {
    throw new InvalidArgumentError(
      `--output-path must use the ${expected} extension for --format ${format}.`
    );
  }
}

function isDirectoryOutput(output: string, resolvedOutput: string): boolean {
  if (fs.existsSync(resolvedOutput)) {
    return fs.statSync(resolvedOutput).isDirectory();
  }
  return (
    output.endsWith('/') || output.endsWith('\\') || path.extname(output) === ''
  );
}

function resolveOutputPath(output: string, cwd: string): string {
  return path.resolve(cwd, output);
}

function createTimestampReportName(format: CodelinterReportFormat): string {
  const now = new Date();
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0'))
    .join('');
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join('');
  const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
  return `${date}-${time}-${milliseconds}${getReportExtension(format)}`;
}

function getReportExtension(format: CodelinterReportFormat): '.json' | '.md' {
  return format === 'json' ? '.json' : '.md';
}

function formatDisplayPath(reportPath: string, cwd: string): string {
  const relative = path.relative(cwd, reportPath);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    return relative;
  }
  return reportPath;
}

function writeTextToStderr(text: string): void {
  if (text) {
    process.stderr.write(text);
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}
