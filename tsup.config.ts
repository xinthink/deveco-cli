/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { defineConfig } from 'tsup';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

export default defineConfig({
  entry: ['src/cli.ts', 'src/internal/doc-init-background.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  clean: true,
  dts: false,
  shims: true,
  minify: true,
  splitting: false,
  external: [
    '@node-rs/jieba',
    '@node-rs/jieba/dict.js',
    'better-sqlite3',
    '@sqlite.org/sqlite-wasm',
    'yauzl',
  ],
  env: {
    npm_package_version: pkg.version,
    npm_package_name: pkg.name,
  },
});
