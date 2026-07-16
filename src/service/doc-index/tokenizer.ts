/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import type { Jieba } from '@node-rs/jieba';
import * as fs from 'fs';
import * as path from 'path';
import { debugLog } from '../../utils/logger.js';
import { getJiebaBackendStateFile } from './doc-paths.js';
import { readIndexLexiconFile } from './lexicon.js';
import { assertSafeRegularFile } from './path-safety.js';
import {
  DOC_SEARCH_BUDGET_API_SYMBOLS,
  DOC_SEARCH_BUDGET_BODY,
  DOC_SEARCH_BUDGET_HEADINGS,
  DOC_SEARCH_BUDGET_TITLE,
  DOC_SEARCH_TEXT_MAX_CHARS,
  DOC_SECTION_BUDGET_API_SYMBOLS,
  DOC_SECTION_BUDGET_BODY,
  DOC_SECTION_BUDGET_HEADINGS,
  DOC_SECTION_BUDGET_TITLE,
  DOC_SECTION_SEARCH_TEXT_MAX_CHARS,
} from './constants.js';
import type { DocumentIndexSource } from './segment-types.js';

let stopWords: Set<string> | null = null;
let jiebaInstance: Jieba | null = null;
let initPromise: Promise<Jieba> | null = null;

function hasPersistedJiebaWasmPreference(): boolean {
  return fs.existsSync(getJiebaBackendStateFile());
}

function writeJiebaBackendState(message: string): void {
  const filePath = getJiebaBackendStateFile();
  const state = {
    backend: 'jieba-wasm',
    reason: 'native-jieba-load-failed',
    message,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  assertSafeRegularFile(filePath);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function loadStopWords(): Set<string> {
  if (stopWords) {
    return stopWords;
  }

  const raw = readIndexLexiconFile('harmonyos-stopwords.txt');
  stopWords = new Set(
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  );
  return stopWords;
}

function mergeDecoratorTokens(tokens: string[]): string[] {
  const merged: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const current = tokens[i]?.trim();
    if (!current) {
      continue;
    }
    const next = tokens[i + 1]?.trim();
    if (current === '@' && next && /^[A-Z][a-zA-Z0-9]*$/.test(next)) {
      merged.push(`@${next}`);
      i += 1;
      continue;
    }
    merged.push(current);
  }
  return merged;
}

function normalizeTokens(tokens: string[]): string[] {
  const stops = loadStopWords();
  const out: string[] = [];

  for (const raw of mergeDecoratorTokens(tokens)) {
    const token = raw.trim();
    if (!token || stops.has(token)) {
      continue;
    }

    out.push(token.toLowerCase());
    if (/[A-Z]/.test(token) && /[a-zA-Z]/.test(token)) {
      out.push(token);
    }
  }

  return out;
}

type JiebaCtor = typeof import('@node-rs/jieba').Jieba;

async function buildJiebaInstance(JiebaClass: JiebaCtor): Promise<Jieba> {
  const { dict } = await import('@node-rs/jieba/dict.js');
  const jieba = JiebaClass.withDict(dict);
  const userDict = readIndexLexiconFile('harmonyos-terms.txt');
  jieba.loadDict(Buffer.from(userDict, 'utf-8'));
  return jieba;
}

async function createJiebaNative(): Promise<Jieba> {
  const { Jieba } = await import('@node-rs/jieba');
  return buildJiebaInstance(Jieba);
}

async function createJiebaWasm(): Promise<Jieba> {
  const { Jieba } = await import('@node-rs/jieba-wasm32-wasi');
  return buildJiebaInstance(Jieba);
}

async function createJieba(): Promise<Jieba> {
  if (hasPersistedJiebaWasmPreference()) {
    const instance = await createJiebaWasm();
    return instance;
  }

  try {
    const instance = await createJiebaNative();
    debugLog('doc-index: using @node-rs/jieba backend');
    return instance;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeJiebaBackendState(message);
    debugLog(
      `doc-index: @node-rs/jieba unavailable (${message}); falling back to wasm32-wasi`
    );
  }

  const instance = await createJiebaWasm();
  debugLog('doc-index: using @node-rs/jieba-wasm32-wasi backend');
  return instance;
}

export async function getJieba(): Promise<Jieba> {
  if (jiebaInstance) {
    return jiebaInstance;
  }

  if (!initPromise) {
    initPromise = createJieba().then((instance) => {
      jiebaInstance = instance;
      return instance;
    });
  }

  return initPromise;
}

export async function tokenizeForIndex(text: string): Promise<string[]> {
  const jieba = await getJieba();
  return normalizeTokens(jieba.cutForSearch(text, true));
}

export async function tokenizeForQuery(text: string): Promise<string[]> {
  const jieba = await getJieba();
  return normalizeTokens(jieba.cut(text, true));
}

async function tokenizeAndCap(text: string, maxChars: number): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed || maxChars <= 0) {
    return '';
  }

  const joined = (await tokenizeForIndex(trimmed)).join(' ');
  if (joined.length <= maxChars) {
    return joined;
  }
  return joined.slice(0, maxChars);
}

async function capApiSymbolsForIndex(
  symbols: string[],
  maxChars: number
): Promise<string> {
  const tokens: string[] = [];
  for (const symbol of symbols) {
    const trimmed = symbol.trim();
    if (!trimmed) {
      continue;
    }
    tokens.push(trimmed.toLowerCase());
    if (/[A-Z]/.test(trimmed)) {
      tokens.push(trimmed);
    }
  }
  const joined = [...new Set(tokens)].join(' ');
  if (joined.length <= maxChars) {
    return joined;
  }
  return joined.slice(0, maxChars);
}

export async function buildDocumentSearchText(
  source: DocumentIndexSource
): Promise<string> {
  const isSectionRow = Boolean(source.sectionTitle.trim());
  const titleRaw = source.titleTokens.trim();
  const maxChars = isSectionRow
    ? DOC_SECTION_SEARCH_TEXT_MAX_CHARS
    : DOC_SEARCH_TEXT_MAX_CHARS;
  const apiBudget = isSectionRow
    ? DOC_SECTION_BUDGET_API_SYMBOLS
    : DOC_SEARCH_BUDGET_API_SYMBOLS;
  const apiText = isSectionRow
    ? await capApiSymbolsForIndex(source.apiSymbols, apiBudget)
    : await tokenizeAndCap(source.apiSymbols.join(' '), apiBudget);
  const parts = await Promise.all([
    tokenizeAndCap(
      titleRaw,
      isSectionRow ? DOC_SECTION_BUDGET_TITLE : DOC_SEARCH_BUDGET_TITLE
    ),
    Promise.resolve(apiText),
    tokenizeAndCap(
      source.headingsText,
      isSectionRow ? DOC_SECTION_BUDGET_HEADINGS : DOC_SEARCH_BUDGET_HEADINGS
    ),
    tokenizeAndCap(
      source.bodySample,
      isSectionRow ? DOC_SECTION_BUDGET_BODY : DOC_SEARCH_BUDGET_BODY
    ),
  ]);

  const joined = parts.filter(Boolean).join(' ');
  if (joined.length <= maxChars) {
    return joined;
  }
  return joined.slice(0, maxChars);
}
