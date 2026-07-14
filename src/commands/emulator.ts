/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { Argument, Command, Option } from 'commander';
import { tryGetHdcShellParams } from '../utils/hdc-param.js';
import { green, cyan, red, yellow, gray } from 'colorette';
import ora, { type Ora } from 'ora';
import { exitWithListCommandError } from '../utils/ora-fail.js';
import { renderTable, type TableRow } from '../utils/text-table.js';
import type { EmulatorInfo } from '../service/emulator-types.js';
import { normalizeListNameKey } from '../service/emulator-types.js';
import {
  EmulatorManager,
  type EmulatorControlAction,
} from '../service/emulator-manager.js';
import { ToolProvider } from '../utils/tool-provider.js';
import {
  DeviceManager,
  isLocalEmulatorSerial,
} from '../service/device-manager.js';
import {
  fetchEmulatorSerials,
  fetchRunningEmulatorHvds,
} from '../utils/emulator-hdc-targets.js';
import {
  EmulatorLicenseBlockedError,
  ensureEmulatorSdkAgreementForImageDownload,
  ensureEmulatorServiceAgreementConfig,
  runEmulatorLicenseAccept,
  runEmulatorLicenseAcceptDirectly,
  runEmulatorLicenseView,
} from '../utils/emulator-license.js';
const SERIAL_PARAM_KEYS = [
  'ohos.qemu.hvd.name',
  'const.product.name',
  'const.product.model',
];

const FOLDED_STATE_VALUES = [
  'open',
  'half-open',
  'close',
  'vertical-open',
  'single',
  'double',
  'triple',
  'left-folded-right-half-folded',
  'left-half-folded-right-expanded',
  'left-expanded-right-folded',
  'left-half-folded-right-folded',
  'left-expanded-right-half-folded',
  'left-half-folded-right-half-folded',
] as const;

const FOLDED_STATE_HELP = `
Folded state scene mappings:
  foldableFold (3):
    open       Fully expanded state
    half-open  Semi-folded state
    close      Fully folded state

  2in1foldableFold (4):
    open           Landscape unfolded state
    vertical-open  Portrait unfolded state
    half-open      Semi-folded state
    close          Magnetic attachment state

  tripleFold (9):
    single
    double
    triple
    left-folded-right-half-folded
    left-half-folded-right-expanded
    left-expanded-right-folded
    left-half-folded-right-folded
    left-expanded-right-half-folded
    left-half-folded-right-half-folded
`;

interface EmulatorTargetOptions {
  target: string;
}

interface BatteryOptions extends EmulatorTargetOptions {
  level?: string;
  status?: 'charging' | 'discharging';
}

interface GeolocationOptions extends EmulatorTargetOptions {
  longitude?: string;
  latitude?: string;
  altitude?: string;
  direction?: string;
}

interface SensorOptions extends EmulatorTargetOptions {
  lightIntensity?: string;
  humidity?: string;
  temperature?: string;
  steps?: string;
  heartrate?: string;
}

function assertTarget(input: string): string {
  const target = input.trim();
  if (!target) {
    throw new Error('--target must not be empty.');
  }
  return target;
}

function parseFoldedState(input: string): string {
  const state = input.trim();
  if (!FOLDED_STATE_VALUES.includes(state as never)) {
    throw new Error(
      `Invalid fold state "${input}". Available values: ${FOLDED_STATE_VALUES.join(', ')}`
    );
  }
  return state;
}

function parseRangeInteger(
  optionName: string,
  input: string,
  min: number,
  max: number
): number {
  const text = input.trim();
  if (!/^-?\d+$/.test(text)) {
    throw new Error(`${optionName} must be an integer in [${min}, ${max}].`);
  }
  const value = Number(text);
  if (value < min || value > max) {
    throw new Error(`${optionName} must be in [${min}, ${max}].`);
  }
  return value;
}

function parseRangeNumberText(
  optionName: string,
  input: string,
  min: number,
  max: number,
  maxDecimalPlaces?: number
): string {
  const text = input.trim();
  const value = Number(text);
  if (!text || Number.isNaN(value)) {
    throw new Error(`${optionName} must be a number in [${min}, ${max}].`);
  }
  if (maxDecimalPlaces !== undefined && !hasValidDecimalPlaces(text, maxDecimalPlaces)) {
    throw new Error(
      `${optionName} supports at most ${maxDecimalPlaces} decimal place(s).`
    );
  }
  if (value < min || value > max) {
    throw new Error(`${optionName} must be in [${min}, ${max}].`);
  }
  return text;
}

function hasValidDecimalPlaces(input: string, maxDecimalPlaces: number): boolean {
  const decimalPart = input.split('.')[1];
  return decimalPart === undefined || decimalPart.length <= maxDecimalPlaces;
}

function parseRangeNumber(
  optionName: string,
  input: string,
  min: number,
  max: number,
  maxDecimalPlaces?: number
): number {
  return Number(
    parseRangeNumberText(optionName, input, min, max, maxDecimalPlaces)
  );
}

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
      `--os-version "${version}" is invalid. use the full image label, e.g. HarmonyOS 5.1.1(19).`
    );
  }
  if (!/^HarmonyOS\s+/i.test(v)) {
    if (/^HarmonyOS$/i.test(v)) {
      throw new Error(
        '--os-version is incomplete (only "HarmonyOS"). On PowerShell/cmd, quote the full label, e.g. --os-version "HarmonyOS 6.0.1(21)".'
      );
    }
    throw new Error(
      `Invalid --os-version "${version}". It must start with "HarmonyOS " (e.g. "HarmonyOS 5.1.1(19)").`
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
        'Run `devecocli emulator image download ...` followed by `devecocli emulator image list` and then copy an `osVersion` string exactly.'
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

const EMULATOR_LIST_TABLE_HEADERS = [
  'Name',
  'Status',
  'Serial',
  'Device Type',
  'OS Version',
] as const;

function buildEmulatorListRow(
  emu: EmulatorInfo,
  serial: string | undefined,
  effectiveRunning: boolean
): TableRow {
  return {
    cells: [
      emu.name,
      effectiveRunning ? 'running' : 'stopped',
      serial ?? '-',
      emu.deviceType ?? '-',
      emu.osVersion ?? '-',
    ],
    highlight: effectiveRunning,
  };
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

interface EnrichedEmulator {
  emu: EmulatorInfo;
  serial: string | undefined;
  effectiveRunning: boolean;
}

function buildSortedEmulatorRows(
  emulators: EmulatorInfo[],
  productSerialMap: Map<string, string>,
  hvdSerialMap: Map<string, string>
): TableRow[] {
  const enriched: EnrichedEmulator[] = emulators.map((emu) => ({
    emu,
    serial: productSerialMap.get(emu.name) ?? hvdSerialMap.get(emu.name),
    effectiveRunning: emu.isRunning === true || hvdSerialMap.has(emu.name),
  }));
  enriched.sort((a, b) => {
    if (a.effectiveRunning !== b.effectiveRunning) {
      return a.effectiveRunning ? -1 : 1;
    }
    return a.emu.name.localeCompare(b.emu.name);
  });
  return enriched.map((item) =>
    buildEmulatorListRow(item.emu, item.serial, item.effectiveRunning)
  );
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
    const rows = buildSortedEmulatorRows(
      emulators,
      productSerialMap,
      hvdSerialMap
    );
    console.log(renderTable(EMULATOR_LIST_TABLE_HEADERS, rows));
  } catch (error) {
    exitWithListCommandError(
      spinner,
      `Failed to list emulators: ${(error as Error).message}`
    );
  }
}

function reportSettledFailures(
  results: PromiseSettledResult<unknown>[],
  identifiers: string[],
  action: 'start' | 'stop'
): boolean {
  let anyFailed = false;
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status !== 'rejected') {
      continue;
    }
    anyFailed = true;
    const e = result.reason as Error & { stdout?: string; stderr?: string };
    console.error(
      red(`Failed to ${action} emulator "${identifiers[i]}": ${e.message}`)
    );
    if (e.stdout) {
      console.error(gray(e.stdout));
    }
    if (e.stderr) {
      console.error(gray(e.stderr));
    }
  }
  return anyFailed;
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

  const anyFailed = reportSettledFailures(results, names, 'start');

  if (anyFailed) {
    process.exit(1);
  }
}

async function resolveEmulatorListName(
  hdcPath: string,
  identifier: string
): Promise<string> {
  const trimmed = identifier.trim();
  if (!isLocalEmulatorSerial(trimmed)) {
    return trimmed;
  }
  const name = await DeviceManager.withHdcPath(hdcPath).getDeviceName(trimmed);
  if (name === trimmed) {
    throw new Error(
      `Cannot resolve a running emulator with serial "${trimmed}". Use \`devecocli emulator list\` or pass the emulator name instead.`
    );
  }
  return name;
}

async function stopOneEmulator(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  identifier: string
): Promise<void> {
  const name = await resolveEmulatorListName(hdcPath, identifier);
  console.log(cyan(`Stopping emulator "${name}"...`));
  const outcome = await emulatorManager.stopEmulator(name);
  if (outcome === 'already-stopped') {
    console.log(yellow(`Emulator "${name}" is already stopped.`));
    return;
  }

  const confirmed = await waitForEmulatorHdcState(hdcPath, name, false);
  if (confirmed) {
    console.log(green(`Emulator "${name}" stopped successfully.`));
  } else {
    console.log(
      yellow(
        `Emulator "${name}" stop signal was sent but the instance is still visible in hdc list targets within the waiting period.`
      )
    );
  }
}

async function stopAction(
  emulatorManager: EmulatorManager,
  hdcPath: string,
  identifiers: string[]
) {
  const results = await Promise.allSettled(
    identifiers.map((id) => stopOneEmulator(emulatorManager, hdcPath, id))
  );

  const anyFailed = reportSettledFailures(results, identifiers, 'stop');

  if (anyFailed) {
    process.exit(1);
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

async function runEmulatorControlAction(
  options: EmulatorTargetOptions,
  actionFactory: () => EmulatorControlAction
): Promise<void> {
  try {
    const target = assertTarget(options.target);
    const action = actionFactory();
    const { manager, toolProvider } = await initEmulatorManager();
    const instanceName = await resolveEmulatorListName(
      toolProvider.hdcPath,
      target
    );
    await manager.controlEmulator(instanceName, action);
    console.log(green(`Emulator "${target}" operation completed.`));
  } catch (error) {
    const target = options.target?.trim() || '<unknown>';
    console.error(
      red(`Failed to operate emulator "${target}": ${(error as Error).message}`)
    );
    process.exit(1);
  }
}

function firstGeolocationAction(
  options: GeolocationOptions
): EmulatorControlAction {
  const actions: EmulatorControlAction[] = [];
  addGpsAction(actions, 'longitude', options.longitude, -180, 180, 8);
  addGpsAction(actions, 'latitude', options.latitude, -90, 90, 8);
  addGpsAction(actions, 'altitude', options.altitude, -10000, 10000, 2);
  addGpsAction(actions, 'bearing', options.direction, 0, 360, 2);
  return singleAction(actions, 'Specify one geolocation option.');
}

function firstSensorAction(options: SensorOptions): EmulatorControlAction {
  const actions: EmulatorControlAction[] = [];
  addSensorAction(actions, 'light', options.lightIntensity, 0, 100000, false);
  addSensorAction(actions, 'humidity', options.humidity, 0, 100, false);
  addSensorAction(actions, 'temperature', options.temperature, -273, 100, false);
  addSensorAction(actions, 'steps', options.steps, 0, 10000, true);
  addSensorAction(actions, 'heartrate', options.heartrate, 0, 255, true);
  return singleAction(actions, 'Specify one sensor option.');
}

function singleAction(
  actions: EmulatorControlAction[],
  emptyMessage: string
): EmulatorControlAction {
  if (actions.length === 0) {
    throw new Error(emptyMessage);
  }
  if (actions.length > 1) {
    throw new Error('Only one operation option can be specified.');
  }
  return actions[0];
}

function addGpsAction(
  actions: EmulatorControlAction[],
  key: 'longitude' | 'latitude' | 'altitude' | 'bearing',
  input: string | undefined,
  min: number,
  max: number,
  maxDecimalPlaces: number
): void {
  if (input === undefined) {
    return;
  }
  actions.push({
    type: 'gps',
    key,
    value: parseRangeNumberText(`--${key}`, input, min, max, maxDecimalPlaces),
  });
}

function addSensorAction(
  actions: EmulatorControlAction[],
  key: 'light' | 'humidity' | 'temperature' | 'steps' | 'heartrate',
  input: string | undefined,
  min: number,
  max: number,
  integer: boolean
): void {
  if (input === undefined) {
    return;
  }
  const value = integer
    ? parseRangeInteger(`--${key}`, input, min, max)
    : parseRangeNumber(`--${key}`, input, min, max, 1);
  actions.push({ type: 'sensor', key, value });
}

function batteryAction(options: BatteryOptions): EmulatorControlAction {
  const actions: EmulatorControlAction[] = [];
  if (options.level !== undefined) {
    actions.push({
      type: 'battery',
      level: parseRangeInteger('--level', options.level, 0, 100),
    });
  }
  if (options.status !== undefined) {
    actions.push({
      type: 'battery-status',
      status: options.status === 'charging' ? 1 : 0,
    });
  }
  return singleAction(actions, 'Specify --level or --status.');
}

const emulatorCommand = new Command('emulator').description(
  'Manage emulator instances'
);

const EMULATOR_IMAGE_DEVICE_TYPES = [
  'phone',
  'foldable',
  'widefold',
  'triplefold',
  'tablet',
  '2in1',
  '2in1 foldable',
  'wearable',
  'tv',
] as const;

function deviceTypeOption(required: boolean): Option {
  const opt = new Option(
    '--device-type <type>',
    'Emulator device type'
  ).choices([...EMULATOR_IMAGE_DEVICE_TYPES]);
  return required ? opt.makeOptionMandatory() : opt;
}

type ImageListFormat = 'table' | 'json';

function getRecordValue(obj: Record<string, unknown>, keys: string[]): unknown {
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

const IMAGE_LIST_TABLE_HEADERS = [
  'OS Version',
  'Device Type',
  'Software Version',
  'Release Type',
  'Upgradable',
  'Downloaded',
] as const;

const EMULATOR_IMAGE_LIST_EMPTY_HINT =
  'No matching system images found. Try `devecocli emulator image list --all`, then download an image via `devecocli emulator image download ...`.';

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
): TableRow[] {
  const rows: TableRow[] = [];
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

/** True when stdout is empty, JSON `[]`, or a JSON array with no renderable image rows. */
function isEmulatorImageListOutputEffectivelyEmpty(stdout: string): boolean {
  const text = stdout.trim();
  if (!text) {
    return true;
  }
  const data = parseJsonArrayOrNull(text);
  if (data === null) {
    return false;
  }
  if (data.length === 0) {
    return true;
  }
  return buildImageListTableRows(data, true).length === 0;
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
  return renderTable(IMAGE_LIST_TABLE_HEADERS, rows);
}

const imageCommand = new Command('image').description(
  'HarmonyOS emulator system images (download, list, remove)'
);

imageCommand
  .command('download')
  .description('Download system image')
  .addOption(deviceTypeOption(false))
  .option(
    '--os-version <version>',
    'Example: HarmonyOS 5.1.1(19) or HarmonyOS 6.0.1(21) (required)'
  )
  .option('--force', 'Overwrite an existing image')
  .action(
    async (opts: {
      deviceType?: string;
      osVersion?: string;
      force?: boolean;
    }) => {
      const { manager, toolProvider } = await initEmulatorManager();
      try {
        await ensureEmulatorSdkAgreementForImageDownload(
          toolProvider.emulatorPath,
          toolProvider.sdkPath
        );
      } catch (error) {
        if (error instanceof EmulatorLicenseBlockedError) {
          console.error(red(error.message));
          process.exit(1);
        }
        throw error;
      }

      if (!opts.deviceType?.trim()) {
        console.error(
          red("Error: missing required option '--device-type <type>'")
        );
        process.exit(1);
      }
      if (!opts.osVersion?.trim()) {
        console.error(
          red("Error: misssing required option '--os-version <version>'")
        );
        process.exit(1);
      }

      try {
        await manager.installEmulatorImage({
          deviceType: opts.deviceType.trim(),
          osVersion: opts.osVersion.trim(),
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
  .requiredOption(
    '--os-version <version>',
    'Supports both image label (HarmonyOS x.y.z(n)) and softwareVersion'
  )
  .action(async (opts: { deviceType: string; osVersion: string }) => {
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
  });

imageCommand
  .command('list')
  .description('List system images')
  .addOption(deviceTypeOption(false))
  .option('--all', 'List all images (local and remote)')
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
        if (isEmulatorImageListOutputEffectivelyEmpty(out)) {
          console.log(yellow(EMULATOR_IMAGE_LIST_EMPTY_HINT));
          return;
        }
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

const licenseCommand = new Command('license').description(
  'Review and accept emulator license agreements interactively (prints full text + y/N prompt)'
);

licenseCommand
  .command('view')
  .description('Review agreement text (read-only, no changes)')
  .action(async () => {
    const { toolProvider } = await initEmulatorManager();
    const code = await runEmulatorLicenseView(
      toolProvider.emulatorPath,
      toolProvider.sdkPath
    );
    process.exit(code);
  });

licenseCommand
  .command('accept')
  .description(
    'Accept all emulator license agreements non-interactively (skips review and prompt)'
  )
  .action(async () => {
    const { toolProvider } = await initEmulatorManager();
    const code = await runEmulatorLicenseAcceptDirectly(
      toolProvider.emulatorPath,
      toolProvider.sdkPath
    );
    process.exit(code);
  });

licenseCommand.action(async () => {
  const { toolProvider } = await initEmulatorManager();
  const code = await runEmulatorLicenseAccept(
    toolProvider.emulatorPath,
    toolProvider.sdkPath
  );
  process.exit(code);
});

emulatorCommand.addCommand(licenseCommand);

emulatorCommand
  .command('shake')
  .description('Trigger shake event')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .action((options: EmulatorTargetOptions) =>
    runEmulatorControlAction(options, () => ({ type: 'shake' }))
  );

emulatorCommand
  .command('power')
  .description('Press power button (toggle screen on/off)')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .action((options: EmulatorTargetOptions) =>
    runEmulatorControlAction(options, () => ({ type: 'power' }))
  );

emulatorCommand
  .command('rotate')
  .description('Rotate emulator')
  .addOption(
    new Option('--target <nameOrSerial>', 'Target emulator name or serial')
      .makeOptionMandatory()
  )
  .addArgument(new Argument('<direction>').choices(['left', 'right']))
  .action((direction: 'left' | 'right', options: EmulatorTargetOptions) =>
    runEmulatorControlAction(options, () => ({ type: 'rotation', direction }))
  );

emulatorCommand
  .command('volume')
  .description('Change volume')
  .addOption(
    new Option('--target <nameOrSerial>', 'Target emulator name or serial')
      .makeOptionMandatory()
  )
  .addArgument(new Argument('<direction>').choices(['up', 'down']))
  .action((direction: 'up' | 'down', options: EmulatorTargetOptions) =>
    runEmulatorControlAction(options, () => ({ type: 'volume', direction }))
  );

emulatorCommand
  .command('fold <state>')
  .description('Set foldable display state')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .addHelpText('after', FOLDED_STATE_HELP)
  .action((state: string, options: EmulatorTargetOptions) =>
    runEmulatorControlAction(options, () => ({
      type: 'folded-state',
      state: parseFoldedState(state),
    }))
  );

emulatorCommand
  .command('battery')
  .description('Set battery level or charging status')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .option('--level <0-100>', 'Battery level, SOC (integer 0-100)')
  .addOption(
    new Option('--status <status>', 'Charging status').choices([
      'charging',
      'discharging',
    ])
  )
  .action((options: BatteryOptions) =>
    runEmulatorControlAction(options, () => batteryAction(options))
  );

emulatorCommand
  .command('geolocation')
  .description('Inject geographic coordinates and direction')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .option('--longitude <value>', 'Longitude (-180.0 to 180.0)')
  .option('--latitude <value>', 'Latitude (-90.0 to 90.0)')
  .option('--altitude <value>', 'Altitude (-10000.0 to 10000.0)')
  .option('--direction <value>', 'Heading direction in degrees (0 to 360)')
  .action((options: GeolocationOptions) =>
    runEmulatorControlAction(options, () => firstGeolocationAction(options))
  );

emulatorCommand
  .command('scene')
  .description('Start motion simulation scene')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .addArgument(
    new Argument('<type>').choices([
      'outdoorRunning',
      'outdoorCycling',
      'drivingNavigation',
    ])
  )
  .action((type: string, options: EmulatorTargetOptions) => {
    const sceneActions: Record<string, EmulatorControlAction> = {
      outdoorRunning: { type: 'outdoor-running' },
      outdoorCycling: { type: 'outdoor-cycling' },
      drivingNavigation: { type: 'driving-navigation' },
    };
    return runEmulatorControlAction(options, () => sceneActions[type]);
  });

emulatorCommand
  .command('sensor')
  .description('Inject sensor data')
  .requiredOption('--target <nameOrSerial>', 'Target emulator name or serial')
  .option('--light-intensity <value>', 'Light sensor (0 to 100000)')
  .option('--humidity <value>', 'Humidity sensor (0 to 100)')
  .option('--temperature <value>', 'Temperature sensor (-273.0 to 100)')
  .option('--steps <value>', 'Steps sensor (integer 0 to 10000)')
  .option('--heartrate <value>', 'Heart rate sensor (integer 0 to 255)')
  .action((options: SensorOptions) =>
    runEmulatorControlAction(options, () => firstSensorAction(options))
  );

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
  .command('start [names...]')
  .description('Start one or more emulator instances')
  .action(async (names: string[]) => {
    const { manager, toolProvider } = await initEmulatorManager();
    try {
      await ensureEmulatorServiceAgreementConfig(
        toolProvider.emulatorPath,
        toolProvider.sdkPath
      );
    } catch (e) {
      if (e instanceof EmulatorLicenseBlockedError) {
        console.error(red(e.message));
        process.exit(1);
      }
      throw e;
    }
    if (!names?.length) {
      console.error(red("Error: missing required argument 'names'"));
      process.exit(1);
    }
    await startAction(manager, toolProvider.hdcPath, names);
  });

emulatorCommand
  .command('stop <names...>')
  .description(
    'Stop one or more emulator instances (by name or serial,e.g.,127.0.0.1:<port>)'
  )
  .action(async (names: string[]) => {
    const { manager, toolProvider } = await initEmulatorManager();
    if (!names?.length) {
      console.error(red("Error: missing required argument 'names'"));
      process.exit(1);
    }
    await stopAction(manager, toolProvider.hdcPath, names);
  });

const createEmulatorCmd = emulatorCommand
  .command('create <name>')
  .description(
    'Create a local emulator by running emulator -create <name> …; --os-version must match a downloaded image from `emulator image list`.'
  )
  .addOption(deviceTypeOption(true))
  .requiredOption(
    '--os-version <version>',
    'Downloaded image label. which will be quoted in PowerShell (e.g. "HarmonyOS 6.0.1(21)") or be used in the format --os-version="…";For details, run`devecocli emulator image list`'
  )
  .option('--force', 'Overwrite if supported');

createEmulatorCmd.configureOutput({
  outputError: (str, write) => {
    write(str);
    if (/too many arguments/i.test(str)) {
      write(
        `\n${yellow('Tip: ')}${gray('Unquoted --os-version values with spaces/parentheses are split into multiple arguments. Use:')}\n` +
          `  ${cyan('devecocli emulator create 123 --device-type phone --os-version "HarmonyOS 6.0.1(21)"')}\n` +
          `  ${cyan('devecocli emulator create 123 --device-type phone --os-version="HarmonyOS 6.0.1(21)"')}\n`
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
        red(`${(error as Error).message}`)
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
      console.error(red(e.message));
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
