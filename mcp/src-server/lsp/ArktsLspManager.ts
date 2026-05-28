/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { LspServerProxy } from './LspServerProxy.js';
import { ConfigFileWatcher, ConfigChangeEvent, ConfigChangeKind } from './watcher/ConfigFileWatcher.js';
import { DependencyMapWatcher, ReloadEvent } from './watcher/DependencyMapWatcher.js';
import { syncProject } from './sync/buildProject.js';
import { ohpmInstallAll } from './sync/ohpmInstall.js';
import { LspMessage, LspNotification, LspRequest, EtsFileItem } from './types.js';
import { JSONRPC_VERSION, LSP_METHOD } from './constant.js';
import { ArkTsProxyError } from './ArkTsProxyError.js';
import { ModuleDependencyInfo } from './model/ModuleDependencyInfo.js';
import { logger } from './logger.js';

export interface ModuleSetItem {
    modulePath: string;
    dependencies: Record<string, ModuleDependencyInfo>;
    dynamicDependencies: Record<string, ModuleDependencyInfo>;
}

export interface ArktsLspManagerConfig {
    sdkPath: string;
    /** DevEco Studio 内 `plugins/openharmony` 目录（含 ace-server/out/index.js） */
    arktsLangServerPath: string;
    workspaceRoot: string;
    indexLogPath: string;
    nodeMaxOldSpaceSize?: number;
}

/**
 * ArktsLspManager
 * - 直接持有 `LspServerProxy`（其内部 spawn 唯一一个 ace-server 子进程）；
 * - 维持 `ConfigFileWatcher` / `DependencyMapWatcher`；
 * - 处理 `arkts/syncProject` 请求（ohpm install + hvigor sync）；
 * - 把 LSP 上行消息（initialized / indexingProgress / publishDiagnostics 等）通过
 *   `setOnMessage` 注册的回调统一上抛给上层（`ArktsCheckTool`）。
 *
 * 不再涉及 UDS / 多客户端 / 心跳 / process.exit。
 */
export class ArktsLspManager {
    private readonly config: ArktsLspManagerConfig;
    private lspProxy: LspServerProxy | null = null;
    private configWatcher: ConfigFileWatcher | null = null;
    private depMapWatcher: DependencyMapWatcher | null = null;
    private isInitialized: boolean = false;
    private lastEditorOpenFiles: EtsFileItem[] = [];
    private onMessage: (msg: LspMessage) => void = () => {};
    /** dispose 仅执行一次 */
    private disposeOnce: Promise<void> | null = null;

    constructor(config: ArktsLspManagerConfig) {
        this.config = config;
    }

    setOnMessage(callback: (msg: LspMessage) => void): void {
        this.onMessage = callback;
    }

    /**
     * 启动配置监听 + 拉起 LSP。该函数会立即返回；真正的"初始化完成"信号通过 onMessage 上抛
     * `arkts/initialized`（成功）或 `arkts/initializationFailed`（失败）。
     */
    async start(editorOpenFiles: EtsFileItem[] = []): Promise<void> {
        this.lastEditorOpenFiles = editorOpenFiles;
        this.startConfigWatcher();
        this.startLspProxy(editorOpenFiles);
    }

    /** 上行通知（如 textDocument/didOpen / didChange / didClose） */
    sendNotification(msg: LspMessage): void {
        if (!this.lspProxy) {
            logger.warn('[ArktsLspManager] sendNotification before LSP ready, dropped');
            return;
        }
        this.lspProxy.sendNotification(msg);
    }

    /** 上行请求（hover / definition / references；当前 arkts-check 未使用） */
    sendRequest(msg: LspRequest): void {
        if (!this.lspProxy) {
            logger.warn('[ArktsLspManager] sendRequest before LSP ready, dropped');
            return;
        }
        this.lspProxy.sendRequest(msg);
    }

    /**
     * 处理 `arkts/syncProject`：先 ohpm install，再 hvigor sync；模型重载由 DependencyMapWatcher
     * 自动触发。无论是否有变化，结束后都通过 `arkts/syncCompleted` 通知上层。
     */
    static async handleSyncProject(workspaceRoot: string, sdkPath?: string): Promise<boolean> {
        logger.info('[ArktsLspManager] Received arkts/syncProject');
        if (!workspaceRoot || !sdkPath) {
            logger.error('[ArktsLspManager] handleSyncProject: workspaceRoot or sdkPath is empty');
            return false;
        }
        const installSuccess = await ohpmInstallAll(workspaceRoot, sdkPath);
        if (!installSuccess) {
            logger.error('[ArktsLspManager] ohpm install failed');
            return false;
        }
        const success = await syncProject(workspaceRoot, sdkPath);
        if (success) {
            logger.info('[ArktsLspManager] syncProject completed successfully');
        } else {
            logger.error('[ArktsLspManager] syncProject failed');
        }
        return success;
    }

    async dispose(): Promise<void> {
        if (!this.disposeOnce) {
            this.disposeOnce = this.performDispose();
        }
        return this.disposeOnce;
    }

    private async performDispose(): Promise<void> {
        try {
            this.configWatcher?.stop();
        } catch (e) {
            logger.warn(`[ArktsLspManager] configWatcher stop error: ${e}`);
        }
        try {
            this.depMapWatcher?.stop();
        } catch (e) {
            logger.warn(`[ArktsLspManager] depMapWatcher stop error: ${e}`);
        }
        this.configWatcher = null;
        this.depMapWatcher = null;
        if (this.lspProxy) {
            try {
                await this.lspProxy.dispose();
            } catch (e) {
                logger.warn(`[ArktsLspManager] lspProxy dispose error: ${e}`);
            }
            this.lspProxy = null;
        }
        this.isInitialized = false;
    }

    // ---------- LSP startup ----------

    private startLspProxy(editorOpenFiles: EtsFileItem[]): void {
        const proxy = new LspServerProxy(
            this.config.sdkPath,
            this.config.arktsLangServerPath,
            this.config.workspaceRoot,
            this.config.indexLogPath,
            this.config.nodeMaxOldSpaceSize,
        );
        proxy.setOnMessage((msg) => this.handleLspMessage(msg));
        proxy.start(editorOpenFiles, (success) => this.handleLspInitialized(success));
        this.lspProxy = proxy;
    }

    private handleLspInitialized = (success: boolean): void => {
        this.isInitialized = success;
        if (success) {
            logger.info('[ArktsLspManager] LSP initialized');
            this.startDependencyMapWatcher();
            this.onMessage({
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.ARKTS_INITIALIZED,
                params: {},
            });
        } else {
            const errorMessage = this.lspProxy?.consumeStartErrorMessage();
            logger.error(`[ArktsLspManager] LSP initialization failed: ${errorMessage}`);
            const proxyError = errorMessage ? ArkTsProxyError.uninitialized(errorMessage) : ArkTsProxyError.unknown();
            this.onMessage({
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.ARKTS_INITIALIZATION_FAILED,
                params: proxyError.toJsonRpcErrorParams(),
            });
            this.lspProxy = null;
        }
    };

    private handleLspMessage(msg: LspMessage): void {
        // LSP 上行消息直接抛给上层。上层（ArktsCheckTool）按 method 自行解析。
        this.onMessage(msg);
    }

    /**
     * 首次 LSP 初始化失败时会把 `lspProxy` 置空；用户 sync 生成依赖图后应再拉起 ace-server，
     * 否则后续 LSP 调用永远没有响应。
     */
    private maybeRetryLspAfterSuccessfulSync(): void {
        if (this.isInitialized || this.lspProxy !== null) {
            return;
        }
        logger.info('[ArktsLspManager] Retrying LSP startup after successful sync');
        this.onMessage({
            jsonrpc: JSONRPC_VERSION,
            method: LSP_METHOD.ARKTS_REINITIALIZING,
            params: {},
        });
        this.startLspProxy(this.lastEditorOpenFiles);
    }

    // ---------- watchers ----------

    private startConfigWatcher(): void {
        if (this.configWatcher) {
            return;
        }
        this.configWatcher = new ConfigFileWatcher(this.config.workspaceRoot);
        this.configWatcher.on('configChanged', (event: ConfigChangeEvent) => this.handleConfigChanged(event));
        this.configWatcher.start();
    }

    private startDependencyMapWatcher(): void {
        if (this.depMapWatcher) {
            return;
        }
        this.depMapWatcher = new DependencyMapWatcher(this.config.workspaceRoot);
        this.depMapWatcher.on('reload', (event: ReloadEvent) => {
            if (!this.lspProxy) {
                logger.warn('[ArktsLspManager] LspServerProxy not initialized, skip reload');
                return;
            }
            const depsOnly = this.lspProxy.reloadDependenciesOnly(event);
            const moduleSet: ModuleSetItem[] = depsOnly.map((d) => ({
                modulePath: d.modulePath ?? '',
                dependencies: d.dependencies ?? {},
                dynamicDependencies: d.dynamicDependencies ?? {},
            }));
            this.lspProxy.sendNotification({
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.ON_DID_CHANGE_PACKAGE_DEPENDENCIES_CLIENT,
                params: { moduleSet },
            });
            // 通知上层清除"需要 Sync"的提示
            this.onMessage({
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.ARKTS_SYNC_COMPLETED,
                params: { success: true },
            });
        });
        this.depMapWatcher.start();
    }

    private handleConfigChanged(event: ConfigChangeEvent): void {
        logger.info(`[ArktsLspManager] Config file changed: ${event.filePath}`);
        try {
            const changeSignal = event.kind ?? ConfigChangeKind.OhPackageChanged;
            const notification: LspNotification = {
                jsonrpc: JSONRPC_VERSION,
                method: LSP_METHOD.WORKSPACE_DID_CHANGE_CONFIGURATION,
                params: {
                    relativePath: event.relativePath,
                    timestamp: event.timestamp,
                    changeSource: event.source,
                    changeSignal,
                    ...(event.filePath && { filePath: event.filePath }),
                    ...(event.fileName !== undefined && { fileName: event.fileName }),
                    ...(event.moduleName !== undefined && { moduleName: event.moduleName }),
                    ...(event.removedModuleName !== undefined && {
                        removedModuleName: event.removedModuleName,
                    }),
                },
            };
            this.onMessage(notification);
        } catch (e) {
            logger.error(`[ArktsLspManager] Failed to handle config change: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}
