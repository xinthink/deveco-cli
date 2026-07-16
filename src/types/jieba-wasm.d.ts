/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

declare module '@node-rs/jieba-wasm32-wasi' {
  import type { Jieba as JiebaClass, TfIdf as TfIdfClass } from '@node-rs/jieba';

  export const Jieba: typeof JiebaClass;
  export const TfIdf: typeof TfIdfClass;
}
