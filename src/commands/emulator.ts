/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Command, Option } from 'commander';
import { tryGetHdcShellParams } from '../utils/hdc-param.js';
import { green, cyan, red, yellow, gray } from 'colorette';
import ora, { type Ora } from 'ora';
import { exitWithListCommandError } from '../utils/ora-fail.js';
import type { EmulatorInfo } from '../service/emulator-types.js';
import { normalizeListNameKey } from '../service/emulator-types.js';
import { EmulatorManager } from '../service/emulator-manager.js';
import { ToolProvider } from '../utils/tool-provider.js';
import {
  fetchEmulatorSerials,
  fetchRunningEmulatorHvds,
} from '../utils/emulator-hdc-targets.js';

const SERIAL_PARAM_KEYS = [
  'ohos.qemu.hvd.name',
  'const.product.name',
  'const.product.model',
];

function validateVirtualDeviceName(name: string): void {
  const n = name.trim();
  if (!n || !/^[A-Za-z0-9_ ]+$/.test(n)) {
    throw new Error(
      'The virtual device name can only contain letters, spaces, numbers, and underscores (_).'
    );
  }
}

function validateEmulatorOsVersionArg(version: string): void {
  const v = version.trim();
  if (!v) {
    throw new Error('--os-version must not be empty.');
  }
  if (/^\d+$/.test(v)) {
    throw new Error(
      `--os-version "${version}" is invalid: use the full image label, e.g. HarmonyOS 5.1.1(19).`
    );
  }
  if (!/^HarmonyOS\s+/i.test(v)) {
    if (/^HarmonyOS$/i.test(v)) {
      throw new Error(
        '--os-version is incomplete (only "HarmonyOS"). On PowerShell/cmd, quote the full label, e.g. --os-version "HarmonyOS 6.0.1(21)"'
      );
    }
    throw new Error(
      `--os-version must start with "HarmonyOS " (e.g. HarmonyOS 5.1.1(19)). Got: "${version}"`
    );
  }
}

function assertOsVersionAgainstDownloadedImages(
  osVersion: string,
  downloaded: string[]
): void {
  const norm = (s: string) => s.normalize('NFKC').trim();
  const user = norm(osVersion);
  if (downloaded.length === 0) {
    console.error(
      yellow(
        'Could not parse any downloaded images from `emulator -imageList -downloaded true` (JSON array expected).'
      )
    );
    console.error(
      yellow(
        'Run `devecocli emulator image download ...` then `devecocli emulator image list` and copy an `osVersion` string exactly.'
      )
    );
    throw new Error(
      'No downloaded osVersion values parsed; cannot validate --os-version.'
    );
  }
  if (!downloaded.some((d) => norm(d) === user)) {
    console.error(
      red(
        `--os-version does not match any downloaded image (exact string required).`
      )
    );
    console.log(yellow('Use one of these --os-version values:'));
    for (const v of downloaded) {
      console.log(`  ${v}`);
    }
    throw new Error(`No downloaded image matches --os-version "${osVersion}".`);
  }
}

function printEmulatorDetail(
  emu: EmulatorInfo,
  serial: string | undefined,
  effectiveRunning: boolean
) {
  const statusText = effectiveRunning ? (serial ?? 'running') : 'stopped';
  console.log(`  ${emu.name} [${statusText}]`);
}


async function fetchSerialParamsBatched(
  hdcPath: string,
  serials: string[]
): Promise<Map<string, Map<string, string>>> {
  const entries = await Promise.all(
    serials.map(async (serial) => {
      const params = await tryGetHdcShellParams(
        hdcPath,
        serial,
        SERIAL_PARAM_KEYS
      );
      return [serial, params] as const;
    })
  );
  return new Map(entries);
}

async function fetchEmulatorListSnapshot(hdcPath: string): Promise<{
  serials: string[];
  params: Map<string, Map<string, string>>;
}> {
  const serials = await fetchEmulatorSerials(hdcPath);
  const params = await fetchSerialParamsBatched(hdcPath, serials);
  return { serials, params };
}

function tryMatchProductSerial(
  serial: string,
  params: Map<string, string> | undefined,
  unmatchedNames: string[],
  unmatchedSerials: string[],
  productSerialMap: Map<string, string>
): void {
  if (!params) {
    return;
  }
  for (const key of ['const.product.name', 'const.product.model']) {
    const value = params.get(key);
    if (!value) {
      continue;
    }
    const idx = unmatchedNames.indexOf(value);
    if (idx === -1) {
      continue;
    }
    unmatchedNames.splice(idx, 1);
    productSerialMap.set(value, serial);
    const sIdx = unmatchedSerials.indexOf(serial);
    if (sIdx !== -1) {
      unmatchedSerials.splice(sIdx, 1);
    }
    return;
  }
}

/** Pure-function map builder over already-fetched params. */
function buildEmulatorMapsFromParams(
  serials: string[],
  serialParams: Map<string, Map<string, string>>,
  runningEmulatorNames: string[]
): {
  productSerialMap: Map<string, string>;
  hvdSerialMap: Map<string, string>;
} {
  const productSerialMap = new Map<string, string>();
  const hvdSerialMap = new Map<string, string>();
  const unmatchedSerials = [...serials];
  const unmatchedNames = [...runningEmulatorNames];
  for (const serial of serials) {
    const params = serialParams.get(serial);
    const hvd = params?.get('ohos.qemu.hvd.name');
    if (hvd) {
      hvdSerialMap.set(hvd, serial);
    }
    if (runningEmulatorNames.length > 0) {
      tryMatchProductSerial(
        serial,
        params,
        unmatchedNames,
        unmatchedSerials,
        productSerialMap
      );
    }
  }
  for (
    let i = 0;
    i < unmatchedNames.length && i < unmatchedSerials.length;
    i++
  ) {
    productSerialMap.set(unmatchedNames[i], unmatchedSerials[i]);
  }

  return { productSerialMap, hvdSerialMap };
}

async function listAction(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  spinner?: Ora
) {
  try {
    const [emulators, hdcSnapshot] = await Promise.all([
      emulatorManager.listEmulators(),
      fetchEmulatorListSnapshot(hdcPath),
    ]);

    if (emulators.length === 0) {
      spinner?.stop();
      console.log(yellow('  No emulator instances found.'));
      console.log(gray('  You can create an emulator in DevEco Studio.'));
      console.log('');
      return;
    }

    const runningNames = emulators
      .filter((e) => e.isRunning)
      .map((e) => e.name);

    const { productSerialMap, hvdSerialMap } = buildEmulatorMapsFromParams(
      hdcSnapshot.serials,
      hdcSnapshot.params,
      runningNames
    );

    spinner?.stop();
    for (const emu of emulators) {
      const serial =
        productSerialMap.get(emu.name) ?? hvdSerialMap.get(emu.name);
      const effectiveRunning =
        emu.isRunning === true || hvdSerialMap.has(emu.name);
      printEmulatorDetail(emu, serial, effectiveRunning);
    }
    console.log('');
  } catch (error) {
    exitWithListCommandError(
      spinner,
      `Failed to list emulators: ${(error as Error).message}`
    );
  }
}

function handleError(action: string, name: string, error: unknown): never {
  const e = error as Error & { stdout?: string; stderr?: string };
  console.error(red(`Failed to ${action} emulator "${name}": ${e.message}`));
  if (e.stdout) {
    console.error(gray(e.stdout));
  }
  if (e.stderr) {
    console.error(gray(e.stderr));
  }
  process.exit(1);
}

const EMULATOR_CONFIRM_POLL_INTERVAL_MS = 2000;
const EMULATOR_CONFIRM_TIMEOUT_MS = 60000;

async function isEmulatorPresentByHdcName(
  hdcPath: string,
  name: string
): Promise<boolean> {
  const targetKey = normalizeListNameKey(name);
  const hvds = await fetchRunningEmulatorHvds(hdcPath);
  return hvds.some((hvd) => normalizeListNameKey(hvd) === targetKey);
}

/**
 * Poll `hdc list targets` until the named emulator reaches the desired
 * presence state (appeared / disappeared), or until the timeout is reached.
 * Returns true when confirmed, false on timeout.
 */
async function waitForEmulatorHdcState(
  hdcPath: string,
  name: string,
  expectPresent: boolean,
  timeoutMs = EMULATOR_CONFIRM_TIMEOUT_MS,
  intervalMs = EMULATOR_CONFIRM_POLL_INTERVAL_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const present = await isEmulatorPresentByHdcName(hdcPath, name);
    if (present === expectPresent) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function startOneEmulator(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  name: string
): Promise<void> {
  const outcome = await emulatorManager.startEmulator(name);
  if (outcome === 'already-running') {
    console.log(yellow(`Emulator "${name}" is already running.`));
    return;
  }

  console.log(cyan(`Starting emulator "${name}"...`));

  const confirmed = await waitForEmulatorHdcState(hdcPath, name, true);
  if (confirmed) {
    console.log(green(`Emulator "${name}" started successfully.`));
  } else {
    console.log(
      yellow(
        `Emulator "${name}" was launched but did not appear in hdc list targets within the timeout.`
      )
    );
  }
}

async function startAction(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  names: string[]
) {
  const results = await Promise.allSettled(
    names.map((name) => startOneEmulator(emulatorManager, hdcPath, name))
  );

  let anyFailed = false;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'rejected') {
      anyFailed = true;
      const e = result.reason as Error & { stdout?: string; stderr?: string };
      console.error(
        red(`Failed to start emulator "${names[i]}": ${e.message}`)
      );
      if (e.stdout) {
        console.error(gray(e.stdout));
      }
      if (e.stderr) {
        console.error(gray(e.stderr));
      }
    }
  }

  console.log('');
  if (anyFailed) {
    process.exit(1);
  }
}

async function stopAction(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  name: string
) {
  console.log(cyan(`Stopping emulator "${name}"...`));
  let outcome: 'stopped' | 'already-stopped';
  try {
    outcome = await emulatorManager.stopEmulator(name);
  } catch (error) {
    handleError('stop', name, error);
  }

  if (outcome === 'already-stopped') {
    console.log(yellow(`Emulator "${name}" is already stopped.`));
    return;
  }

  const confirmed = await waitForEmulatorHdcState(hdcPath, name, false);
  if (confirmed) {
    console.log(green(`Emulator "${name}" stopped successfully!`));
  } else {
    console.log(
      yellow(
        `Emulator "${name}" stop signal was sent but the instance is still visible in hdc list targets within the timeout.`
      )
    );
  }
}

async function initEmulatorManager(): Promise<{
  manager: EmulatorManager;
  toolProvider: ToolProvider;
}> {
  try {
    const toolProvider = await ToolProvider.new();
    const manager = EmulatorManager.from(toolProvider);
    return { manager, toolProvider };
  } catch (error) {
    console.error(
      red(`Failed to initialize emulator: ${(error as Error).message}`)
    );
    process.exit(1);
    return undefined as never;
  }
}

const emulatorCommand = new Command('emulator').description(
  'Manage emulator instances'
);

const EMULATOR_IMAGE_DEVICE_TYPES = [
  'Phone',
  'Foldable',
  'WideFold',
  'TripleFold',
  'Tablet',
  '2in1',
  '2in1 Foldable',
  'Wearable',
  'TV',
] as const;

function deviceTypeOption(required: boolean) {
  const opt = new Option(
    '--device-type <type>',
    'Emulator device type'
  ).choices([...EMULATOR_IMAGE_DEVICE_TYPES]);
  return required ? opt.makeOptionMandatory() : opt;
}

type ImageListFormat = 'table' | 'json';

function getRecordValue(
  obj: Record<string, unknown>,
  keys: string[]
): unknown {
  for (const k of keys) {
    if (k in obj) {
      return obj[k];
    }
  }
  return undefined;
}

function toText(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return String(value).trim();
}

function toBoolText(value: unknown): string {
  const t = toText(value).toLowerCase();
  if (t === 'true') {
    return 'true';
  }
  if (t === 'false') {
    return 'false';
  }
  return t;
}

type ImageListTableRow = { cells: string[]; highlight: boolean };

const IMAGE_LIST_TABLE_HEADERS = [
  'OS Version',
  'Device Type',
  'Software Version',
  'Release Type',
  'Upgradable',
  'Downloaded',
] as const;

function parseJsonArrayOrNull(text: string): unknown[] | null {
  try {
    const data = JSON.parse(text) as unknown;
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function buildImageListTableRows(
  data: unknown[],
  highlightDownloaded: boolean
): ImageListTableRow[] {
  const rows: ImageListTableRow[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const row = item as Record<string, unknown>;
    const osVersion = toText(
      getRecordValue(row, ['osVersion', 'OsVersion', 'OSVersion', 'os_version'])
    );
    const deviceType = toText(
      getRecordValue(row, ['deviceType', 'DeviceType', 'device_type'])
    );
    const downloaded = toBoolText(
      getRecordValue(row, ['downloaded', 'Downloaded', 'isDownloaded'])
    );
    const softwareVersion = toText(
      getRecordValue(row, [
        'SoftWareVersion',
        'SoftwareVersion',
        'softwareVersion',
        'software_version',
        'version',
      ])
    );
    const releaseType = toText(
      getRecordValue(row, ['releaseType', 'ReleaseType', 'release_type'])
    );
    const upgradable = toBoolText(
      getRecordValue(row, ['upgradable', 'Upgradable', 'isUpgradable'])
    );
    rows.push({
      cells: [
        osVersion,
        deviceType,
        softwareVersion,
        releaseType,
        upgradable,
        downloaded,
      ],
      highlight: highlightDownloaded && downloaded === 'true',
    });
  }
  return rows;
}

function computeTableWidths(
  headers: readonly string[],
  rows: ImageListTableRow[]
): number[] {
  return headers.map((h, idx) => {
    let w = h.length;
    for (const r of rows) {
      w = Math.max(w, (r.cells[idx] ?? '').length);
    }
    return w;
  });
}

function padCell(s: string, w: number): string {
  return s + ' '.repeat(Math.max(0, w - s.length));
}

function renderTable(
  headers: readonly string[],
  widths: number[],
  rows: ImageListTableRow[]
): string {
  const lines: string[] = [];
  lines.push(headers.map((h, i) => padCell(h, widths[i])).join('  '));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) {
    const line = r.cells
      .map((c, i) => padCell(c ?? '', widths[i]))
      .join('  ')
      .trimEnd();
    lines.push(r.highlight ? green(line) : line);
  }
  return lines.join('\n');
}

function formatImageListTable(
  stdout: string,
  highlightDownloaded: boolean
): string {
  const text = stdout.trim();
  if (!text) {
    return '';
  }
  const data = parseJsonArrayOrNull(text);
  if (!data) {
    return stdout.trimEnd();
  }
  const rows = buildImageListTableRows(data, highlightDownloaded);
  const widths = computeTableWidths(IMAGE_LIST_TABLE_HEADERS, rows);
  return renderTable(IMAGE_LIST_TABLE_HEADERS, widths, rows);
}

const imageCommand = new Command('image').description(
  'HarmonyOS emulator system images (download, list, remove)'
);

imageCommand
  .command('download')
  .description('Download a system image')
  .addOption(deviceTypeOption(true))
  .requiredOption(
    '--os-version <version>',
    'e.g. HarmonyOS 5.1.1(19) or HarmonyOS 6.0.1(21)'
  )
  .option('--force', 'Overwrite an existing image')
  .action(
    async (opts: {
      deviceType: string;
      osVersion: string;
      force?: boolean;
    }) => {
      const { manager } = await initEmulatorManager();
      try {
        await manager.installEmulatorImage({
          deviceType: opts.deviceType,
          osVersion: opts.osVersion,
          force: opts.force === true,
        });
      } catch (error) {
        console.error(
          red(`Failed to download system image: ${(error as Error).message}`)
        );
        process.exit(1);
      }
    }
  );

imageCommand
  .command('remove')
  .description('Remove a downloaded system image')
  .addOption(deviceTypeOption(true))
  .requiredOption('--os-version <version>', 'Same format as for download')
  .action(
    async (opts: {
      deviceType: string;
      osVersion: string;
    }) => {
      const { manager } = await initEmulatorManager();
      try {
        await manager.uninstallEmulatorImage({
          deviceType: opts.deviceType,
          osVersion: opts.osVersion,
        });
      } catch (error) {
        console.error(
          red(`Failed to remove system image: ${(error as Error).message}`)
        );
        process.exit(1);
      }
    }
  );

imageCommand
  .command('list')
  .description('List system images')
  .addOption(deviceTypeOption(false))
  .option('--all', 'List all images (downloaded and not downloaded)')
  .addOption(
    new Option('--format <format>', 'Output format')
      .choices(['table', 'json'])
      .default('table')
  )
  .action(
    async (opts: {
      deviceType?: string;
      all?: boolean;
      format?: ImageListFormat;
    }) => {
      const { manager } = await initEmulatorManager();
      try {
        let downloaded: boolean | undefined;
        if (opts.all) {
          downloaded = undefined;
        } else {
          downloaded = true;
        }
        const out = await manager.listEmulatorImages({
          deviceType: opts.deviceType,
          downloaded,
        });
        if (opts.format === 'json') {
          console.log(out.trimEnd());
          return;
        }
        const table = formatImageListTable(out, opts.all === true);
        console.log(table);
      } catch (error) {
        console.error(
          red(`Failed to list emulator images: ${(error as Error).message}`)
        );
        process.exit(1);
      }
    }
  );

emulatorCommand.addCommand(imageCommand);

emulatorCommand
  .command('list')
  .description('List all emulator instances')
  .action(async () => {
    const { manager, toolProvider } = await initEmulatorManager();
    const spinner = ora({
      text: 'Listing emulators…',
      color: 'cyan',
    }).start();
    await listAction(manager, toolProvider.hdcPath, spinner);
  });

emulatorCommand
  .command('start <names...>')
  .description('Start one or more emulator instances')
  .action(async (names: string[]) => {
    const { manager, toolProvider } = await initEmulatorManager();
    await startAction(manager, toolProvider.hdcPath, names);
  });

emulatorCommand
  .command('stop <name>')
  .description('Stop an emulator instance')
  .action(async (name: string) => {
    const { manager, toolProvider } = await initEmulatorManager();
    await stopAction(manager, toolProvider.hdcPath, name);
  });

const createEmulatorCmd = emulatorCommand
  .command('create <name>')
  .description(
    'Create a local emulator. Runs emulator -create <name> …; --os-version must match a downloaded image from `emulator image list`.'
  )
  .addOption(deviceTypeOption(true))
  .requiredOption(
    '--os-version <version>',
    'Exact downloaded image label. Quote in PowerShell (e.g. "HarmonyOS 6.0.1(21)") or use --os-version="…"; see `devecocli emulator image list`'
  )
  .option('--force', 'Overwrite if the tool supports it');

createEmulatorCmd.configureOutput({
  outputError: (str, write) => {
    write(str);
    if (/too many arguments/i.test(str)) {
      write(
        `\n${yellow('Tip: ')}${gray('Unquoted --os-version values with spaces/parentheses are split into multiple arguments. Use:')}\n` +
          `  ${cyan('devecocli emulator create 123 --device-type Phone --os-version "HarmonyOS 6.0.1(21)"')}\n` +
          `  ${cyan('devecocli emulator create 123 --device-type Phone --os-version="HarmonyOS 6.0.1(21)"')}\n`
      );
    }
  },
});

createEmulatorCmd.action(
  async (
    name: string,
    opts: {
      deviceType: string;
      osVersion: string;
      force?: boolean;
    }
  ) => {
    try {
      validateVirtualDeviceName(name);
      validateEmulatorOsVersionArg(opts.osVersion);
      const { manager } = await initEmulatorManager();
      const downloaded = await manager.listDownloadedImageOsVersions();
      assertOsVersionAgainstDownloadedImages(opts.osVersion, downloaded);
      console.log(cyan(`Creating emulator "${name}"...`));
      await manager.createVirtualDevice({
        name,
        deviceType: opts.deviceType,
        osVersion: opts.osVersion,
        force: opts.force === true,
      });
      console.log(green(`Emulator "${name}" created successfully.`));
    } catch (error) {
      console.error(
        red(`Failed to create emulator: ${(error as Error).message}`)
      );
      process.exit(1);
    }
  }
);

emulatorCommand
  .command('delete <name>')
  .description('Delete a local emulator instance')
  .action(async (name: string) => {
    const { manager } = await initEmulatorManager();
    console.log(cyan(`Deleting emulator "${name}"...`));
    try {
      const deletedName = await manager.deleteVirtualDevice(name);
      console.log(green(`Emulator "${deletedName}" deleted successfully.`));
    } catch (error) {
      const e = error as Error & { stdout?: string; stderr?: string };
      console.error(red(`Failed to delete emulator: ${e.message}`));
      if (e.stdout) {
        console.error(gray(e.stdout));
      }
      if (e.stderr) {
        console.error(gray(e.stderr));
      }
      process.exit(1);
    }
  });

export default emulatorCommand;
