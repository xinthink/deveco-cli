/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, InvalidArgumentError } from 'commander';
import * as path from 'path';
import * as os from 'os';
import { Project } from '../utils/project.js';
import {
  readdirSync,
  existsSync,
  readFileSync,
  unlinkSync,
  copyFileSync,
  writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { ToolProvider } from '../toolchain/index.js';
import { HvigorAdapter } from '../utils/hvigor-adapter.js';
import { red, cyan, yellow } from 'colorette';
import { debugLog } from '../utils/logger.js';

/**
 * `--format` 取值。`default` 默认为 `csv`
 */
const FORMAT_ALIASES: Readonly<Record<string, 'csv' | 'json'>> = {
  csv: 'csv',
  default: 'csv',
  json: 'json',
};

function parseFormatValue(value: string): 'csv' | 'json' {
  const normalized = FORMAT_ALIASES[value];
  if (normalized) {
    return normalized;
  }
  throw new InvalidArgumentError(
    `--format must be one of: csv, json (got "${value}")`
  );
}

/**
 * commander 用的 `--format` 校验器。
 */
function parseFormat(value: string): 'csv' | 'json' {
  return parseFormatValue(value);
}

/**
 * `--limit` 取值校验。
 */
function parseLimit(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new InvalidArgumentError(
      `--limit must be a positive integer (got "${value}")`
    );
  }
  return n;
}

/**
 * 平台白名单检查。
 */
function checkOsSupported(): void {
  const platform = os.platform();
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(
      `Unsupported platform: ${platform}. compat only supports macOS and Windows.`
    );
  }
}

/**
 * 返回 arkanalyzer-apiscan 插件目录的绝对路径。
 */
async function getPluginPath(): Promise<string> {
  checkOsSupported();
  const platform = os.platform();
  const toolProvider = await ToolProvider.new();
  const contentsPrefix = platform === 'darwin' ? 'Contents' : '';
  return path.join(
    toolProvider.devecoStudioPath,
    contentsPrefix,
    'plugins',
    'harmony',
    'arkanalyzer-apiscan'
  );
}

/**
 * 升序排序 SDK 版本号。版本号形式 `*_X.Y.Z(N)_<suffix>`
 */
function sortVersions(versions: string[]): string[] {
  return [...versions].sort((left, right) => {
    const leftParsed = parseSdkVersion(left);
    const rightParsed = parseSdkVersion(right);
    return (
      leftParsed.apiVersion - rightParsed.apiVersion ||
      leftParsed.suffix.localeCompare(rightParsed.suffix)
    );
  });
}

function parseSdkVersion(version: string): { apiVersion: number; suffix: string } {
  const parenMatch = version.match(/\((\d+)\)/);
  const apiVersion = parenMatch ? Number(parenMatch[1]) : 0;
  const lastUnderscore = version.lastIndexOf('_');
  const suffix = lastUnderscore >= 0 ? version.slice(lastUnderscore + 1) : version;
  return { apiVersion, suffix };
}

/**
 * 读取可用 SDK 版本列表。
 */
function listApiChangeVersions(apiChangeDir: string): string[] {
  if (!existsSync(apiChangeDir)) {
    throw new Error(
      `apiChange directory not found at: ${apiChangeDir}\n` +
        `Ensure DevEco Studio (>= 6.1.0) is installed correctly.`
    );
  }
  const entries = readdirSync(apiChangeDir, { withFileTypes: true });
  const versions = entries
    .filter(
      (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json')
    )
    .map((entry) => entry.name.slice(0, -'.json'.length));
  return sortVersions(versions);
}

/**
 * 从 process.argv 读 `--format` 值。
 */
function readFormatFromArgv(fallback: 'csv' | 'json'): 'csv' | 'json' {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let value: string | undefined;
    if (arg === '--format' && i + 1 < argv.length) {
      value = argv[i + 1];
    } else if (arg.startsWith('--format=')) {
      value = arg.slice('--format='.length);
    }
    if (value !== undefined) {
      return parseFormatValue(value);
    }
  }
  return fallback;
}

/**
 * `compat versions` 入口。
 */
async function handleVersionsCommand(
  format: 'csv' | 'json'
): Promise<void> {
  try {
    const pluginPath = await getPluginPath();
    const apiChangeDir = path.join(pluginPath, 'resources', 'apiChange');
    debugLog(cyan(`[compat:versions] apiChangeDir: "${apiChangeDir}"`));

    const versions = listApiChangeVersions(apiChangeDir);

    if (format === 'json') {
      console.log(
        JSON.stringify({ count: versions.length, versions }, null, 2)
      );
    } else {
      if (versions.length === 0) {
        console.log('No SDK versions available.');
        return;
      }
      console.log(versions.join('\n'));
    }
  } catch (error) {
    console.error(red((error as Error).message));
    process.exit(1);
  }
}

interface CheckOptions {
  sourceVersion?: string;
  targetVersion?: string;
  modules?: string[];
  format: 'csv' | 'json';
  outputPath?: string;
  limit: number;
}

/**
 * CSV 报告中的一行变更记录。
 */
interface ApiChangeRecord {
  apiDefinition: string;
  language: string;
  changeId: string;
  changedInSdk: string;
  affectedVersions: string;
  title: string;
  codeLocation: string;
  changeType: string;
}

/**
 * 文件级扫描支持的后缀白名单。
 */
const SUPPORTED_FILE_EXTS = new Set(['.ets', '.c', '.cpp']);

/**
 * 校验模块名是否存在。
 */
function validateModulesExist(project: Project, modules: string[]): void {
  const known = new Set(project.profile.modules.map((m) => m.name));
  const missing = modules.filter((m) => !known.has(m));
  if (missing.length === 0) {
    return;
  }
  const knownList = project.profile.modules.map((m) => m.name).join(', ');
  const verb = missing.length > 1 ? 'are' : 'is';
  throw new Error(
    `Module ${missing.map((m) => `"${m}"`).join(', ')} ${verb} not defined in ` +
      `build-profile.json5. Available modules: ${knownList}.`
  );
}

/**
 * 校验文件是否存在且后缀合法。
 */
function validateFiles(files: string[]): void {
  for (const raw of files) {
    const f = path.resolve(raw);
    if (!existsSync(f)) {
      throw new Error(`File "${raw}" does not exist.`);
    }
    const ext = path.extname(f).toLowerCase();
    if (!SUPPORTED_FILE_EXTS.has(ext)) {
      const supportedList = Array.from(SUPPORTED_FILE_EXTS).join(', ');
      throw new Error(
        `Unsupported file extension "${ext}" for "${raw}". ` +
          `Supported: ${supportedList}.`
      );
    }
  }
}

/**
 * 按后缀拆分文件为 arkTs / cpp 两组。
 */
function splitFilesByKind(files: string[]): {
  arkTs: string[];
  cpp: string[];
} {
  const arkTs: string[] = [];
  const cpp: string[] = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext === '.ets') {
      arkTs.push(f);
    } else {
      cpp.push(f);
    }
  }
  return { arkTs, cpp };
}

/**
 * 解析 RFC4180 风格 CSV：双引号包裹字段，内部 `""` 表示字面 `"`。
 */
function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let current: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      ({ field, inQuotes, i } = stepQuotedChar(text, i, ch, field, inQuotes));
    } else if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      current.push(field);
      field = '';
      i += 1;
    } else if (ch === '\n') {
      current.push(field);
      rows.push(current);
      current = [];
      field = '';
      i += 1;
    } else if (ch === '\r') {
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (field.length > 0 || current.length > 0) {
    current.push(field);
    rows.push(current);
  }
  return rows;
}

/**
 * 在引号段内推进一个字符。
 */
function stepQuotedChar(
  text: string,
  index: number,
  ch: string,
  field: string,
  inQuotes: boolean
): { field: string; inQuotes: boolean; i: number } {
  if (ch !== '"') {
    return { field: field + ch, inQuotes, i: index + 1 };
  }
  if (text[index + 1] === '"') {
    return { field: field + '"', inQuotes, i: index + 2 };
  }
  return { field, inQuotes: false, i: index + 1 };
}

/**
 * 表头和行转为 ApiChangeRecord 数组。
 */
function rowsToRecords(header: string[], rows: string[][]): ApiChangeRecord[] {
  return rows.map(cols => {
    const get = (name: string): string => {
      const idx = header.indexOf(name);
      return idx >= 0 && idx < cols.length ? cols[idx] : '';
    };
    return {
      apiDefinition: get('Api Definition'),
      language: get('Language'),
      changeId: get('ChangeId'),
      changedInSdk: get('Changed in SDK'),
      affectedVersions: get('Affected Versions'),
      title: get('Title'),
      codeLocation: get('Code Location'),
      changeType: get('Change Type'),
    };
  });
}

/**
 * 解析 API 变更 CSV 报告。
 */
function parseApiChangeCsv(csvPath: string): ApiChangeRecord[] {
  const raw = readFileSync(csvPath, 'utf8');
  // 去掉 UTF-8 BOM（如果存在）
  const text = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;

  const rows = parseCsvText(text);
  if (rows.length < 2) {
    return [];
  }
  const [header, ...dataRows] = rows;
  return rowsToRecords(header, dataRows);
}

/**
 * 从工具输出中按 `CSV saved to:` 关键字解析结果文件路径。
 */
function extractCsvPathFromOutput(stdout: string, outputDir: string): string | null {
  const m = stdout.match(/CSV saved to:\s*([^\r\n]+\.csv)/);
  if (!m) {
    return null;
  }
  const raw = m[1].trim();
  return path.isAbsolute(raw) ? raw : path.join(outputDir, raw);
}

/**
 * 打印扫描汇总信息（按 Change Type 分组统计）。
 */
function printSummary(records: ApiChangeRecord[], csvPath: string | null): void {
  const counts = new Map<string, number>();
  for (const r of records) {
    const t = r.changeType || '(unknown)';
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const groups = Array.from(counts.entries()).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  const labelWidth = Math.max(5, ...groups.map(([t]) => t.length));
  console.log(cyan('API change scan summary:'));
  console.log(`  ${'Total'.padEnd(labelWidth)}  ${records.length}`);
  for (const [type, count] of groups) {
    console.log(`  ${type.padEnd(labelWidth)}  ${count}`);
  }
  if (csvPath) {
    console.log(`  ${'Report'.padEnd(labelWidth)}  ${csvPath}`);
  }
}

/**
 * 打印 text 格式的明细。
 */
function printDetailsText(records: ApiChangeRecord[], limit: number): void {
  console.log();
  if (records.length === 0) {
    console.log('No API changes detected.');
    return;
  }

  const shown = records.slice(0, limit);
  const hidden = records.length - shown.length;
  console.log(
    cyan(
      `Details (showing ${shown.length}${hidden > 0 ? ` of ${records.length}` : ''}):`
    )
  );

  const fields: ReadonlyArray<readonly [string, keyof ApiChangeRecord]> = [
    ['Title', 'title'],
    ['Language', 'language'],
    ['ChangeId', 'changeId'],
    ['Changed in', 'changedInSdk'],
    ['Affected Versions', 'affectedVersions'],
    ['Code Location', 'codeLocation'],
  ];
  const labelWidth = Math.max(...fields.map(([label]) => label.length));
  const display = (raw: string): string => raw || '<unknown>';

  for (const r of shown) {
    console.log(`  [${display(r.changeType)}] ${display(r.apiDefinition)}`);
    for (const [label, key] of fields) {
      console.log(`    ${label.padEnd(labelWidth)}  ${display(r[key])}`);
    }
  }

  if (hidden > 0) {
    console.log(
      yellow(
        `  ... and ${hidden} more. you can re-run with --output-path <dir> to save the full report.`
      )
    );
  }
}

/**
 * 打印 json 格式的明细。
 */
function printDetailsJson(records: ApiChangeRecord[]): void {
  console.log();
  console.log(JSON.stringify({ count: records.length, records }, null, 2));
}

/**
 * 把模块名解析为绝对路径。
 */
function resolveModulePaths(
  project: Project,
  moduleNames: string[]
): string[] {
  const result: string[] = [];
  for (const name of moduleNames) {
    const mod = project.profile.modules.find((m) => m.name === name);
    if (!mod) {
      // 理论上 `validateModulesExist` 已经拦过，这里再兜底一次
      throw new Error(`Module "${name}" not found in build-profile.json5.`);
    }
    result.push(path.resolve(project.rootDir, mod.srcPath));
  }
  return result;
}

/**
 * 构造 api-change-scan 工具参数。
 */
function buildToolArgs(
  scriptPath: string,
  files: string[],
  project: Project,
  options: CheckOptions
): string[] {
  if (!options.sourceVersion || !options.targetVersion) {
    throw new Error('source-version and target-version are required.');
  }
  const args: string[] = [
    scriptPath,
    '--startVersion',
    options.sourceVersion,
    '--endVersion',
    options.targetVersion,
  ];

  if (files.length > 0) {
    const { arkTs, cpp } = splitFilesByKind(files);
    const toAbs = (f: string) => path.resolve(process.cwd(), f);
    const arkTsAbs = arkTs.map(toAbs);
    const cppAbs = cpp.map(toAbs);
    if (arkTsAbs.length > 0) {
      args.push('--arkTsFiles', arkTsAbs.join(','));
    }
    if (cppAbs.length > 0) {
      args.push('--cppFiles', cppAbs.join(','));
    }
  } else if (options.modules && options.modules.length > 0) {
    const modulePaths = resolveModulePaths(project, options.modules);
    args.push('--modulePaths', modulePaths.join(','));
  } else {
    args.push('--projectPath', project.rootDir);
  }
  args.push('--outputPath', os.tmpdir());
  return args;
}

/**
 * 执行 api-change-scan 工具。
 */
async function runScanTool(args: string[]): Promise<string> {
  const toolProvider = await ToolProvider.new();
  const cwd = path.dirname(args[0]);
  try {
    const stdout = execFileSync(toolProvider.nodePath, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'inherit'],
      encoding: 'utf8',
    });
    if (process.env.DEVECO_CLI_DEBUG) {
      console.log(cyan('[compat:check] === api-change-scan.js stdout ==='));
      process.stdout.write(stdout);
      if (!stdout.endsWith('\n')) {
        process.stdout.write('\n');
      }
      console.log(cyan('[compat:check] === end stdout ==='));
    }
    return stdout;
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    if (process.env.DEVECO_CLI_DEBUG && e.stdout) {
      console.log(cyan('[compat:check] === api-change-scan.js stdout (on error) ==='));
      process.stdout.write(e.stdout);
      if (!e.stdout.endsWith('\n')) {
        process.stdout.write('\n');
      }
      console.log(cyan('[compat:check] === end stdout ==='));
    }
    const message = new Error(
      `api-change-scan.js failed: ${e.message}` +
        (e.stderr ? `\n${e.stderr}` : '')
    );
    if (e.stdout) {
      (message as Error & { stdout?: string }).stdout = e.stdout;
    }
    throw message;
  }
}

/**
 * 校验必需参数和互斥关系。
 */
function validateCheckOptions(files: string[], options: CheckOptions): void {
  if (files.length > 0 && options.modules && options.modules.length > 0) {
    throw new Error(
      'Cannot use `--modules` together with file arguments. ' +
        'Use either file-level scanning (with files) or module-level scanning (with --modules).'
    );
  }
  if (!options.sourceVersion) {
    throw new Error('--source-version is required.');
  }
  if (!options.targetVersion) {
    throw new Error('--target-version is required.');
  }
}

/**
 * 校验版本号是否有效且顺序正确。
 */
function validateVersionsInCatalog(
  options: CheckOptions,
  availableVersions: string[]
): void {
  const missing: string[] = [];
  if (options.sourceVersion && !availableVersions.includes(options.sourceVersion)) {
    missing.push(`--source-version "${options.sourceVersion}"`);
  }
  if (options.targetVersion && !availableVersions.includes(options.targetVersion)) {
    missing.push(`--target-version "${options.targetVersion}"`);
  }
  if (missing.length > 0) {
    const preview =
      availableVersions.length <= 5
        ? availableVersions.map((v) => `  ${v}`).join('\n')
        : `${availableVersions
            .slice(0, 5)
            .map((v) => `  ${v}`)
            .join('\n')}\n  ... (${availableVersions.length - 5} more)`;
    const verb = missing.length > 1 ? 'are' : 'is';
    throw new Error(
      `${missing.join(' and ')} ${verb} not in the available SDK version list.\n` +
        `Run \`devecocli compat versions\` to see all available versions, e.g.:\n` +
        `${preview}`
    );
  }

  if (options.sourceVersion && options.targetVersion) {
    const sourceIdx = availableVersions.indexOf(options.sourceVersion);
    const targetIdx = availableVersions.indexOf(options.targetVersion);
    if (sourceIdx >= targetIdx) {
      throw new Error(
        `--target-version "${options.targetVersion}" must be later than ` +
          `--source-version "${options.sourceVersion}". ` +
          `Run \`devecocli compat versions\` to see the available order.`
      );
    }
  }
}

/**
 * 解析 api-change-scan.js 脚本路径。
 */
function resolveScanScript(pluginPath: string): string {
  const scriptPath = path.join(pluginPath, 'api-change-scan.js');
  if (!existsSync(scriptPath)) {
    throw new Error(
      `api-change-scan.js not found at: ${scriptPath}. ` +
        `Ensure DevEco Studio (>= 6.1.0) is installed correctly.`
    );
  }
  return scriptPath;
}

/**
 * 按格式输出扫描结果。
 */
function outputRecords(
  records: ApiChangeRecord[],
  csvPath: string | null,
  format: 'csv' | 'json',
  limit: number,
  outputTargetKind: 'file' | 'dir' | 'none'
): void {
  // 1. 汇总段：所有组合都统一格式
  printSummary(records, csvPath);

  // 2. 明细段：仅在没传 --output-path 时打印（否则明细已经在文件里）
  if (outputTargetKind === 'none') {
    if (format === 'json') {
      printDetailsJson(records);
    } else {
      printDetailsText(records, limit);
    }
  }
}

/**
 * 打印可手动复跑的命令行。
 */
function debugLogRunnableCommand(scriptPath: string, args: string[]): void {
  const scriptDir = path.dirname(scriptPath);
  const scriptBase = path.basename(scriptPath);
  const relArgs = args
    .slice(1)
    .map((a) => (a.startsWith('--') ? a : `"${a}"`))
    .join(' ');
  debugLog(
    cyan(
      `[compat:check] command: cd "${scriptDir}" && node "${scriptBase}" ${relArgs}`
    )
  );
}

/**
 * 删除临时报告文件。
 */
function cleanupTmpReport(csvPath: string): void {
  try {
    unlinkSync(csvPath);
    debugLog(cyan(`[compat:check] cleaned up tmp report: "${csvPath}"`));
  } catch (err) {
    debugLog(
      cyan(
        `[compat:check] failed to clean up tmp report: ${(err as Error).message}`
      )
    );
  }
}

/**
 * 文件输出支持的扩展名。
 */
const FILE_OUTPUT_EXTS = ['.csv', '.json'] as const;
type FileOutputExt = (typeof FILE_OUTPUT_EXTS)[number];

function isFileOutputExt(ext: string): ext is FileOutputExt {
  return (FILE_OUTPUT_EXTS as readonly string[]).includes(ext.toLowerCase());
}

/**
 * 输出目标类型。
 */
type OutputTarget =
  | { kind: 'file'; filePath: string; ext: FileOutputExt }
  | { kind: 'dir'; dirPath: string }
  | { kind: 'none' };

/**
 * `--output-path` 文件扩展名对应的 `--format`。
 */
const EXT_TO_FORMAT: Readonly<Record<FileOutputExt, 'csv' | 'json'>> = {
  '.csv': 'csv',
  '.json': 'json',
};

/**
 * 校验文件扩展名与格式是否匹配。
 */
function validateExtMatchesFormat(
  ext: FileOutputExt,
  format: 'csv' | 'json'
): void {
  if (EXT_TO_FORMAT[ext] !== format) {
    throw new Error(
      `The --output-path file extension '${ext}' does not match --format ${format}. ` +
        `Use --format ${EXT_TO_FORMAT[ext]}, or rename the file to a matching extension.`
    );
  }
}

/**
 * 解析输出目标类型。
 */
function resolveOutputTarget(
  outputPath: string | undefined,
  format: 'csv' | 'json'
): OutputTarget {
  if (!outputPath) {
    return { kind: 'none' };
  }
  const ext = path.extname(outputPath).toLowerCase();
  if (isFileOutputExt(ext)) {
    validateExtMatchesFormat(ext, format);
    return {
      kind: 'file',
      filePath: path.resolve(outputPath),
      ext,
    };
  }
  return { kind: 'dir', dirPath: path.resolve(outputPath) };
}

/**
 * 校验输出目标是否可写。
 */
function validateOutputTarget(target: OutputTarget): void {
  if (target.kind === 'file') {
    if (existsSync(target.filePath)) {
      throw new Error(
        `Target file "${target.filePath}" already exists. ` +
          `Remove it first, or choose a different --output-path.`
      );
    }
    const parentDir = path.dirname(target.filePath);
    if (!existsSync(parentDir)) {
      throw new Error(
        `Target directory "${parentDir}" does not exist. ` +
          `Create it first, or choose a different --output-path.`
      );
    }
  } else if (target.kind === 'dir') {
    if (!existsSync(target.dirPath)) {
      throw new Error(
        `Target directory "${target.dirPath}" does not exist. ` +
          `Create it first, or choose a different --output-path.`
      );
    }
  }
}

/**
 * 写入报告文件。
 */
function writeReportFile(
  tmpCsvPath: string,
  records: ApiChangeRecord[],
  filePath: string,
  ext: FileOutputExt
): void {
  if (ext === '.csv') {
    copyFileSync(tmpCsvPath, filePath);
  } else {
    const payload = JSON.stringify(
      { count: records.length, records },
      null,
      2
    );
    writeFileSync(filePath, payload + '\n', 'utf8');
  }
  debugLog(cyan(`[compat:check] saved report: "${filePath}"`));
}

/**
 * 复制报告到用户指定目录。
 */
function persistCsvToDir(tmpCsvPath: string, userOutputDir: string): string {
  const destPath = path.join(userOutputDir, path.basename(tmpCsvPath));
  copyFileSync(tmpCsvPath, destPath);
  debugLog(cyan(`[compat:check] saved report: "${destPath}"`));
  return destPath;
}

/**
 * 执行 hvigor compileNative 生成 native 产物。
 */
async function runHvigorCompileNative(options: CheckOptions): Promise<void> {
  const toolProvider = await ToolProvider.new();
  const hvigor = new HvigorAdapter(toolProvider, process.cwd(), true);
  const compileModule =
    options.modules && options.modules.length > 0
      ? options.modules[0]
      : undefined;
  try {
    await hvigor.compileNative('default', compileModule);
  } catch (cause) {
    throw new Error(
      `hvigorw compileNative failed (module=${compileModule ?? '<project>'}): ` +
        (cause as Error).message,
      { cause }
    );
  }
}

/**
 * `compat` 命令入口。
 */
async function handleCheckCommand(
  files: string[],
  options: CheckOptions
): Promise<void> {
  try {
    validateCheckOptions(files, options);

    const project = Project.discover(process.cwd());
    if (options.modules && options.modules.length > 0) {
      validateModulesExist(project, options.modules);
    }
    if (files.length > 0) {
      validateFiles(files);
    }

    const pluginPath = await getPluginPath();
    const scriptPath = resolveScanScript(pluginPath);
    debugLog(cyan(`[compat:check] script: "${scriptPath}"`));

    const apiChangeDir = path.join(pluginPath, 'resources', 'apiChange');
    const availableVersions = listApiChangeVersions(apiChangeDir);
    validateVersionsInCatalog(options, availableVersions);

    if (options.outputPath) {
      debugLog(cyan(`[compat:check] outputPath: "${options.outputPath}"`));
    }

    const target = resolveOutputTarget(options.outputPath, options.format);
    debugLog(cyan(`[compat:check] outputTarget: ${target.kind}`));
    validateOutputTarget(target);

    await runHvigorCompileNative(options);

    const args = buildToolArgs(scriptPath, files, project, options);
    debugLogRunnableCommand(scriptPath, args);

    const stdout = await runScanTool(args);
    const tmpCsvPath = extractCsvPathFromOutput(stdout, os.tmpdir());
    if (!tmpCsvPath) {
      throw new Error('api-change-scan.js did not print "CSV saved to: <path>" — tool output format may have changed.');
    }
    debugLog(cyan(`[compat:check] tmp csv: "${tmpCsvPath}"`));

    const records = parseApiChangeCsv(tmpCsvPath);

    let finalPath: string | null = null;
    if (target.kind === 'file') {
      writeReportFile(tmpCsvPath, records, target.filePath, target.ext);
      finalPath = target.filePath;
    } else if (target.kind === 'dir') {
      finalPath = persistCsvToDir(tmpCsvPath, target.dirPath);
    }
    cleanupTmpReport(tmpCsvPath);

    outputRecords(records, finalPath, options.format, options.limit, target.kind);
  } catch (error) {
    console.error(red((error as Error).message));
    process.exit(1);
  }
}

/**
 * 根 `compat` 命令。
 */
const compatCommand = new Command('compat').description(
  'Compatibility checking utilities.'
);

compatCommand
  .description(
    'Check source code compatibility against a target SDK version. ' +
      'By default, performs a project-level scan; pass positional `files...` for file-level scanning; pass `--modules` for module-level scanning.'
  )
  .arguments('[files...]')
  .option(
    '--source-version <version>',
      'Current project SDK version (required; use `compat versions` to list available versions). ' +
      'On zsh, quote the value because version strings contain parentheses; run `compat versions` first to copy a real example.'
  )
  .option(
    '--target-version <version>',
      'Target SDK version (required; use `compat versions` to list available versions). ' +
      'On zsh, quote the value because version strings contain parentheses; run `compat versions` first to copy a real example.'
  )
  .option(
    '--modules <modules...>',
    'Modules to check (default: all modules in the project). Mutually exclusive with positional file arguments.'
  )
  .option(
    '--format <format>',
    'Output format (choices: csv, json; "default" is accepted as an alias for csv)',
    parseFormat,
    'csv'
  )
  .option(
    '--output-path <path>',
    'Directory to write the detailed report CSV to (default: ./compat-output)'
  )
  .option(
    '--limit <num>',
    'Maximum number of change records to display (default: 100)',
    parseLimit,
    100
  )
  .action(async (files: string[], options: CheckOptions) => {
    await handleCheckCommand(files, options);
  });

compatCommand
  .command('versions')
  .description(
    'List all available target SDK versions for compatibility checking'
  )
  .action(async () => {
    const format = readFormatFromArgv('csv');
    await handleVersionsCommand(format);
  });

export default compatCommand;
