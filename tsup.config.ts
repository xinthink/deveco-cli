/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */
import { defineConfig } from 'tsup';
import fs from 'fs';

const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  clean: true,
  dts: false,
  shims: true,
  minify: true,
  splitting: false,
  env: {
    npm_package_version: pkg.version,
    npm_package_name: pkg.name,
  },
});
