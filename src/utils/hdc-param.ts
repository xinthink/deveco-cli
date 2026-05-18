/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { runCommand } from './cmd.js';
import { debugLog } from './logger.js';

/** Normalize `hdc shell param get` stdout (`key = value` or raw). */
export function parseHdcParamStdout(stdout: string): string {
  const t = stdout.trim();
  const i = t.indexOf('=');
  return i !== -1 ? t.slice(i + 1).trim() : t;
}

export type HdcOutputClass = 'ok' | 'fatal' | 'transient';

const TRANSIENT_PATTERNS: RegExp[] = [
  /communication channel is being established/i,
  /please wait for several seconds and try again/i,
  /device offline/i,
  /\[E0+04\]/i,
];

const FATAL_PATTERNS: RegExp[] = [
  /\[fail\]/i,
  /\bfail!/i,
  /not found/i,
];

export function classifyHdcOutput(text: string | undefined): HdcOutputClass {
  if (!text) {
    return 'ok';
  }
  if (TRANSIENT_PATTERNS.some((re) => re.test(text))) {
    return 'transient';
  }
  if (FATAL_PATTERNS.some((re) => re.test(text))) {
    return 'fatal';
  }
  return 'ok';
}

/** Backoff schedule for transient hdc failures. ~4.8 s total wall time. */
const RETRY_DELAYS_MS = [800, 1500, 2500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface HdcCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run `hdc <args>` with transient-error retries (channel establishing,
 * device offline, etc.). Returns the final raw result; the caller still owns
 * exit-code handling and stdout parsing — but the `[E000004] communication
 * channel is being established` window is transparently waited out.
 */
export async function runHdcWithRetry(
  hdcPath: string,
  args: string[]
): Promise<HdcCommandResult> {
  const attempts = 1 + RETRY_DELAYS_MS.length;
  let last: HdcCommandResult = { stdout: '', stderr: '', exitCode: -1 };
  for (let attempt = 0; attempt < attempts; attempt++) {
    last = await runCommand(hdcPath, args);
    const probe = last.exitCode === 0 ? last.stdout : last.stderr || last.stdout;
    if (classifyHdcOutput(probe) !== 'transient') {
      return last;
    }
    if (attempt >= attempts - 1) {
      return last;
    }
    debugLog(
      `hdc transient failure on \`${args.join(' ')}\`: retrying in ${RETRY_DELAYS_MS[attempt]}ms`
    );
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
  return last;
}

/**
 * Read a single `param get` value from a device. Returns `undefined` on any
 * failure (including transient errors that exhausted the retry budget).
 */
export async function tryGetHdcShellParam(
  hdcPath: string,
  deviceId: string,
  paramKey: string
): Promise<string | undefined> {
  const result = await runHdcWithRetry(hdcPath, [
    '-t',
    deviceId,
    'shell',
    'param',
    'get',
    paramKey,
  ]);
  if (result.exitCode !== 0) {
    return undefined;
  }
  const raw = result.stdout.trim();
  if (!raw || classifyHdcOutput(raw) !== 'ok') {
    return undefined;
  }
  return parseHdcParamStdout(raw);
}

const BATCH_DELIM = '__DEVECO_PARAM_DELIM__';

function parseBatchedParamSegments(
  stdout: string,
  paramKeys: string[]
): Map<string, string> {
  const values = new Map<string, string>();
  const segments = stdout.split(BATCH_DELIM);
  for (let i = 0; i < paramKeys.length; i++) {
    const raw = (segments[i] ?? '').trim();
    if (!raw || classifyHdcOutput(raw) !== 'ok') {
      continue;
    }
    const value = parseHdcParamStdout(raw);
    if (value) {
      values.set(paramKeys[i], value);
    }
  }
  return values;
}

/**
 * Batched `param get` for many keys in a single shell invocation. Same
 * transient-error retry semantics as {@link tryGetHdcShellParam}; per-key
 * fatal errors are silently skipped so partial results still flow through.
 */
export async function tryGetHdcShellParams(
  hdcPath: string,
  deviceId: string,
  paramKeys: string[]
): Promise<Map<string, string>> {
  if (paramKeys.length === 0) {
    return new Map();
  }
  if (paramKeys.length === 1) {
    const result = new Map<string, string>();
    const v = await tryGetHdcShellParam(hdcPath, deviceId, paramKeys[0]);
    if (v) {
      result.set(paramKeys[0], v);
    }
    return result;
  }

  const command =
    paramKeys.map((k) => `param get ${k}`).join(`; echo ${BATCH_DELIM}; `) +
    `; echo ${BATCH_DELIM}`;
  const result = await runHdcWithRetry(hdcPath, [
    '-t',
    deviceId,
    'shell',
    command,
  ]);
  if (result.exitCode !== 0) {
    return new Map();
  }
  return parseBatchedParamSegments(result.stdout, paramKeys);
}
