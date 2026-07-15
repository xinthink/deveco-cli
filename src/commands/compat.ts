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
 * `--format` 取值校验。
 */
function parseFormat(value: string): 'default' | 'json' {
  if (value !== 'default' && value !== 'json') {
    throw new InvalidArgumentError(
      `--format must be one of: default, json (got "${value}")`
    );
  }
  return value;
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
 * 版本号升序排序。
 */
function sortVersions(versions: string[]): string[] {
  return [...versions].sort();
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
function readFormatFromArgv(fallback: 'default' | 'json'): 'default' | 'json' {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--format' && i + 1 < argv.length) {
      const v = argv[i + 1];
      if (v === 'default' || v === 'json') {
        return v;
      }
      throw new InvalidArgumentError(
        `--format must be one of: default, json (got "${v}")`
      );
    }
    if (arg.startsWith('--format=')) {
      const v = arg.slice('--format='.length);
      if (v === 'default' || v === 'json') {
        return v;
      }
      throw new InvalidArgumentError(
        `--format must be one of: default, json (got "${v}")`
      );
    }
  }
  return fallback;
}

/**
 * `compat versions` 入口。
 */
async function handleVersionsCommand(
  format: 'default' | 'json'
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
  format: 'default' | 'json';
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
    // Windows 用户经常在文件路径末尾加 `\` / `/`，先剥掉再判断扩展名 / 存在性，
    // 避免 `file.ets/` 被当成一个不存在的路径。
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
/**
 * 找最新生成的 CSV 报告文件。
 */
function findLatestCsvReport(outputDir: string): string {
  const entries = readdirSync(outputDir, { withFileTypes: true });
  const csvs = entries
    .filter(
      e =>
        e.isFile() &&
        e.name.startsWith('apiChange-res') &&
        e.name.toLowerCase().endsWith('.csv')
    )
    .map(e => e.name)
    .sort();
  if (csvs.length === 0) {
    throw new Error(
      `No apiChange-res*.csv report found in: ${outputDir}. ` +
        'The scan tool did not produce a report (maybe the snapshot files are missing).'
    );
  }
  return path.join(outputDir, csvs[csvs.length - 1]);
}

/**
 * 解析 CSV 文本为二维数组。
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
      const next = handleQuotedChar(text, i, ch);
      field += next.added;
      i = next.nextIndex;
      inQuotes = next.inQuotes;
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

function handleQuotedChar(
  text: string,
  index: number,
  ch: string
): { added: string; nextIndex: number; inQuotes: boolean } {
  if (ch !== '"') {
    return { added: ch, nextIndex: index + 1, inQuotes: true };
  }
  if (text[index + 1] === '"') {
    return { added: '"', nextIndex: index + 2, inQuotes: true };
  }
  return { added: '', nextIndex: index + 1, inQuotes: false };
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
 * 从工具输出中提取 CSV 文件路径。
 */
function extractCsvPathFromOutput(stdout: string, outputDir: string): string | null {
  const m = stdout.match(/CSV saved to:\s*(.+\.csv)/);
  if (m && m[1]) {
    return path.isAbsolute(m[1]) ? m[1] : path.join(outputDir, m[1]);
  }
  return null;
}

/**
 * 打印扫描汇总信息。
 */
function printSummary(records: ApiChangeRecord[], csvPath: string | null): void {
  console.log(cyan('API change scan summary:'));
  console.log(`  Total:   ${records.length}`);
  console.log(`  Added:   ${records.filter((r) => r.changeType === 'added').length}`);
  console.log(`  Removed: ${records.filter((r) => r.changeType === 'removed').length}`);
  console.log(`  Modified:${records.filter((r) => r.changeType === 'modified').length}`);
  if (csvPath) {
    console.log(`  Report:  ${csvPath}`);
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
  for (const r of shown) {
    const symbol = r.apiDefinition || '<unknown>';
    const location = r.codeLocation ? ` @ ${r.codeLocation}` : '';
    console.log(
      `  [${r.changeType}] ${symbol}${location} — ${r.title} ` +
        `(${r.affectedVersions})`
    );
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
  console.log(JSON.stringify(records, null, 2));
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
  format: 'default' | 'json',
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
 * 校验文件扩展名与格式是否匹配。
 */
function validateExtMatchesFormat(
  ext: FileOutputExt,
  format: 'default' | 'json'
): void {
  if (ext === '.json' && format !== 'json') {
    throw new Error(
      `The --output-path file extension '${ext}' does not match --format ${format}. ` +
        `Add --format json, or rename the file to a .csv extension.`
    );
  }
  if (ext === '.csv' && format !== 'default') {
    throw new Error(
      `The --output-path file extension '${ext}' does not match --format ${format}. ` +
        `Switch to --format default, or rename the file to a .json extension.`
    );
  }
}

/**
 * 解析输出目标类型。
 */
function resolveOutputTarget(
  outputPath: string | undefined,
  format: 'default' | 'json'
): OutputTarget {
  if (!outputPath) {
    return { kind: 'none' };
  }
  // Windows 用户经常在路径末尾加 `\`，直接 `path.extname` 会把它算成扩展名的一部分
  // （例如 `file.json\` → `.json\`），导致本应是文件的路径被误判成目录。
  // 先剥掉末尾的 `/` 或 `\`，后续用 `path.resolve` 二次规范化。
  const stripped = outputPath.replace(/[/\\]+$/, '');
  const ext = path.extname(stripped).toLowerCase();
  if (isFileOutputExt(ext)) {
    validateExtMatchesFormat(ext, format);
    return {
      kind: 'file',
      filePath: path.resolve(stripped),
      ext,
    };
  }
  return { kind: 'dir', dirPath: path.resolve(stripped) };
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
  const hvigor = new HvigorAdapter(toolProvider, process.cwd());
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

    // 模块 / 文件校验需要先发现工程；任何一种模式（工程/模块/文件）都做这一步，
    // 便于尽早给出清晰的"模块名不存在"或"文件不存在/后缀不合法"错误。
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
    const tmpCsvPath =
      extractCsvPathFromOutput(stdout, os.tmpdir()) ??
      findLatestCsvReport(os.tmpdir());
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
    'Output format (choices: default, json)',
    parseFormat,
    'default'
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
    const format = readFormatFromArgv('default');
    await handleVersionsCommand(format);
  });

export default compatCommand;
