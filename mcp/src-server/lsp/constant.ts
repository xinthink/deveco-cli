/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export const LSP_TO_SERVER = {
    EXIT: 'exit',
    INITIALIZED: 'initialized',
    ON_DID_CHANGE_PACKAGE_DEPENDENCIES: 'aceProject/onDidChangePackageDependencies',
    ON_ASYNC_DID_OPEN: 'aceProject/onAsyncDidOpen',
    ON_ASYNC_DID_CHANGE: 'aceProject/onAsyncDidChange',
    DID_CLOSE: 'textDocument/didClose',
    ON_ASYNC_HOVER: 'aceProject/onAsyncHover',
    ON_ASYNC_DEFINITION: 'aceProject/onAsyncDefinition',
    ON_ASYNC_FIND_USAGES: 'aceProject/onAsyncFindUsages',
} as const;

/**
 * 与 IDE 客户端（socket）相关：代理发往客户端、IDE 发往代理、或 CallbackRegistry 等用的 `method` / key。
 * 含 arkts/*、从 ace 转发/广播给客户端的通知、以及标准 LSP 在 IDE 侧的 method 名。
 */
export const LSP_CLIENT = {
    MODULE_INIT_FINISH: 'aceProject/onModuleInitFinish',
    INDEXING_PROGRESS_UPDATE: 'aceProject/onIndexingProgressUpdate',
    /** 广播给所有客户端时的回调 key，invoke 时传入 LspMessage */
    BROADCAST: 'lsp/broadcast',
    ARKTS_ERROR: 'arkts/error',
    ON_FORCE_OPEN_FILE: 'aceProject/onForceOpenFile',
    ON_PACKAGE_CHANGE_FINISH: 'aceProject/onPackageChangeFinish',
    PUBLISH_DIAGNOSTICS: 'textDocument/publishDiagnostics',
    HOVER: 'textDocument/hover',
    TEXT_DOCUMENT_ON_ASYNC_DEFINITION: 'textDocument/onAsyncDefinition',
    REFERENCES: 'textDocument/references',
    DID_OPEN: 'textDocument/didOpen',
    DID_CHANGE: 'textDocument/didChange',
    DEFINITION: 'textDocument/definition',
    ON_DID_CHANGE_PACKAGE_DEPENDENCIES_CLIENT: 'textDocument/onDidChangePackageDependencies',
    WORKSPACE_DID_CHANGE_CONFIGURATION: 'workspace/didChangeConfiguration',
    ARKTS_INITIALIZED: 'arkts/initialized',
    ARKTS_INITIALIZATION_FAILED: 'arkts/initializationFailed',
    ARKTS_INDEXING_PROGRESS: 'arkts/indexingProgress',
    ARKTS_SYNC_PROJECT: 'arkts/syncProject',
    ARKTS_SYNC_COMPLETED: 'arkts/syncCompleted',
    ARKTS_REINITIALIZING: 'arkts/reinitializing',
    WORKSPACE_DID_CHANGE_WATCHED_FILES: 'workspace/didChangeWatchedFiles',
} as const;

/** 合并视图；与 CallbackRegistry 的 key、既有 `LSP_METHOD.xxx` 引用保持一致 */
export const LSP_METHOD = {
    ...LSP_TO_SERVER,
    ...LSP_CLIENT,
} as const;

export const JSONRPC_VERSION = '2.0';

export const LSP_SEND_LABEL = {
    EXIT: 'exit',
    INITIALIZED: 'initialized',
    EMPTY: 'empty',
    ON_DID_CHANGE_PACKAGE_DEPENDENCIES: 'onDidChangePackageDependencies',
    ON_ASYNC_DID_OPEN: 'onAsyncDidOpen',
    ON_ASYNC_DID_CHANGE: 'onAsyncDidChange',
    DID_CLOSE: 'didClose',
    ON_ASYNC_HOVER: 'onAsyncHover',
    ON_ASYNC_DEFINITION: 'onAsyncDefinition',
    ON_ASYNC_FIND_USAGES: 'onAsyncFindUsages',
} as const;

export enum DependencyMapParseStatus {
    OK = 'OK',
    ERROR = 'ERROR',
}

export interface DependencyMapParseResult {
    status: DependencyMapParseStatus;
    message?: string;
}

/** LSP 初始化等待超时：进度重置与初始化总等待统一为 15 分钟 */
export const LSP_INIT_TIMEOUT_MS = 15 * 60 * 1000;
