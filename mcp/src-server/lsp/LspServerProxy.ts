/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { EtsFileItem, isNotificationRequest, LspMessage, LspNotification, LspRequest, LspResponse } from './types.js';
import { ClientMessageHandle } from './core/ClientMessageHandle.js';
import { getLogPath, logger } from './logger.js';
import path from 'path';
import { InitializationOptions } from './model/InitializationOptions.js';
import { ModuleModel } from './model/ModuleModel.js';
import { ModuleJsonParam } from './model/ModuleJsonParam.js';
import { ModulesDependencyParse, DepsOnlyItem } from './parse/ModulesDependencyParse.js';
import { Capabilities } from './model/Capabilities/Capabilities.js';
import { Params } from './model/Params.js';
import { ModuleDependencyInfo } from './model/ModuleDependencyInfo.js';
import { normalizePath, toFileUri } from './utils.js';
import { ReloadEvent } from './watcher/DependencyMapWatcher.js';
import { JSONRPC_VERSION, LSP_INIT_TIMEOUT_MS, LSP_METHOD, LSP_SEND_LABEL } from './constant.js';
import { isRecord } from './common/typeGuards.js';
import { isContentChange, isPosition, isStringArray, isTextDocument } from './lspTypeGuards.js';

/**
 * LspServerProxy
 *
 * 进程内单例：直接持有 ClientMessageHandle（其内部 spawn 唯一一个 ace-server 子进程），
 * 把 LSP 上行消息（initialized/indexingProgress/publishDiagnostics 等）通过 setOnMessage 注册的
 * 回调统一抛给上层（ArktsLspManager / ArktsCheckTool），不再走 UDS / 多客户端广播。
 */
export class LspServerProxy {
    private messageHandle: ClientMessageHandle;
    private serverPath: string;
    private logPath: string;
    private lastStartErrorMessage: string | null = null;
    /** 初始化与 reload 时使用的 Params，modules 存于 initializationOptions.modules */
    private currentParams: Params | null = null;
    private indexLogPath: string;
    /** 上一轮 reload 返回的 depsOnly，用于 byName 为空时作为“旧状态”做 diff（标出删除的依赖） */
    private lastDepsOnlyForDiff: DepsOnlyItem[] = [];

    /** 当前模块列表（从 currentParams 读取，便于复用逻辑） */
    private get currentModuleModels(): ModuleModel[] {
        return this.currentParams?.initializationOptions?.modules ?? [];
    }

    constructor(
        private sdkPath: string,
        arktsLangServer: string,
        private rootUri: string,
        indexLogPath: string,
        private nodeMaxOldSpaceSize?: number,
    ) {
        this.serverPath = path.resolve(arktsLangServer, 'ace-server', 'out', 'index.js');
        this.logPath = getLogPath();
        this.indexLogPath = indexLogPath || this.logPath;
        this.messageHandle = new ClientMessageHandle({
            serverPath: this.serverPath,
            logPath: this.logPath,
            nodeMaxOldSpaceSize: this.nodeMaxOldSpaceSize,
            indexingDataLocation: this.indexLogPath,
        });
        // 把 ClientMessageHandle 的 broadcastToClients 直接桥接到本类的 onLspMessage，
        // 这样上层只需 setOnMessage 一个入口即可拿到所有 LSP 上行消息。
        this.messageHandle.setBroadcastToClients((msg: LspMessage) => this.onLspMessage(msg));
    }

    async start(editorOpenFiles: EtsFileItem[], onInitialized?: (success: boolean) => void): Promise<void> {
        let success = false;
        try {
            logger.info(`serverPath: ${this.serverPath}`);
            logger.info(`rootUri: ${this.rootUri}`);
            logger.info(`sdkPath: ${this.sdkPath}`);
            logger.info(`logPath: ${this.logPath}`);
            await this.messageHandle.start();

            const fileUri = toFileUri(this.rootUri);
            const options = new InitializationOptions(fileUri, this.serverPath, this.logPath, this.indexLogPath);

            const moduleModels: ModuleModel[] = [];
            const parser = new ModulesDependencyParse(this.rootUri, this.sdkPath);
            const depMapResult = parser.getAllDependencyMap(moduleModels);
            if (depMapResult.status === 'ERROR') {
                throw new Error(`${depMapResult.message}`);
            }
            this.fillModuleModelsPaths(moduleModels);

            options.modules = moduleModels;
            this.currentParams = new Params(fileUri, options, new Capabilities());
            this.messageHandle.sendInitialize(this.currentParams, 1);

            this.messageHandle.onIndexingProgressUpdate(() => {
                this.onLspMessage({
                    jsonrpc: JSONRPC_VERSION,
                    method: LSP_METHOD.ARKTS_INDEXING_PROGRESS,
                    params: {},
                });
            });

            await this.withResettableTimeout(
                (resolve, reset) => {
                    this.messageHandle.onIndexingProgressUpdate(reset);
                    this.messageHandle.onInitializationCompleted(resolve);
                },
                'LSP initialization',
                LSP_INIT_TIMEOUT_MS,
            );

            this.messageHandle.sendInitialized(editorOpenFiles);
            success = true;
        } catch (e) {
            this.lastStartErrorMessage = e instanceof Error ? e.message : String(e);
            logger.error(`[LSP] Initialization failed: ${this.lastStartErrorMessage}`);
            await this.messageHandle.stop();
        }
        onInitialized?.(success);
    }

    consumeStartErrorMessage(): string | null {
        const message = this.lastStartErrorMessage;
        this.lastStartErrorMessage = null;
        return message;
    }

    private onLspMessage: (msg: LspMessage) => void = () => {};

    setOnMessage(callback: (msg: LspMessage) => void): void {
        this.onLspMessage = callback;
    }

    registerDiagnosticCallback(filePath: string): void {
        const uri = toFileUri(filePath);
        this.messageHandle.registerRequestCallback(uri, (method: string, payload: unknown) => {
            const diagnosticPayload = isRecord(payload) ? payload : {};
            logger.info(`[LSP] onDiagnosticCompleted called, filePath: ${filePath}`);
            const response: LspNotification = {
                jsonrpc: JSONRPC_VERSION,
                method,
                params: {
                    uri: typeof diagnosticPayload.uri === 'string' ? diagnosticPayload.uri : uri,
                    diagnostics: Array.isArray(diagnosticPayload.diagnostics)
                        ? diagnosticPayload.diagnostics.filter((d): d is string => typeof d === 'string')
                        : [],
                    ...(typeof diagnosticPayload.errorMessage === 'string'
                        ? { errorMessage: diagnosticPayload.errorMessage }
                        : {}),
                },
            };
            this.onLspMessage(response);
        });
    }

    registerRequestCallback(globalId: number | string, requestId: number): void {
        this.messageHandle.registerRequestCallback(requestId, (method: string, payload: unknown) => {
            logger.info(`[LSP] onRequestCompleted called, requestId: ${requestId}, method: ${method}`);
            const response: LspResponse = {
                jsonrpc: JSONRPC_VERSION,
                id: globalId,
                result: isRecord(payload) ? payload.result : undefined,
            };
            this.onLspMessage(response);
        });
    }

    /**
     * 仅解析依赖并更新 ModuleModel，通知 LSP。
     * - 工程级 oh-package 变化（event.fullReload）：解析全部模块的依赖。
     * - 模块级依赖变化（!fullReload）：只解析 event.changedModules 的依赖，与当前列表合并。
     */
    reloadDependenciesOnly(event?: ReloadEvent): DepsOnlyItem[] {
        const fullReload = event?.fullReload ?? false;
        const parser = new ModulesDependencyParse(this.rootUri, this.sdkPath);
        const byName = this.getModuleModelsByName();

        if (fullReload) {
            logger.info("[LspServerProxy] Project-level oh-package changed, parsing all modules' dependencies");
            const depsOnly = parser.getDependenciesOnly();
            this.markDependencyTypesIncremental(depsOnly);
            const moduleModels = this.mergeDepsOnlyIntoModuleList(depsOnly, byName);
            this.applyModuleModelsUpdate(moduleModels);
            logger.info(`[LspServerProxy] Dependencies only (all) reloaded, count: ${moduleModels.length}`);
            this.lastDepsOnlyForDiff = depsOnly;
            return depsOnly;
        }

        const changedModules = event?.changedModules ?? [];
        const removedSet = new Set(event?.removedModuleNames ?? []);
        if (changedModules.length === 0 && removedSet.size === 0) {
            logger.info('[LspServerProxy] No changed/removed modules, skip dependency reload');
            return [];
        }

        logger.info(`[LspServerProxy] Module-level deps changed, parsing: [${changedModules.join(', ')}]`);
        const depsOnly = parser.getDependenciesOnly(changedModules);
        this.markDependencyTypesIncremental(depsOnly);
        const moduleModels = this.mergeIncrementalDeps(this.currentModuleModels, removedSet, depsOnly);
        this.applyModuleModelsUpdate(moduleModels);
        logger.info(`[LspServerProxy] Dependencies only (incremental) reloaded, count: ${moduleModels.length}`);
        this.lastDepsOnlyForDiff = depsOnly;
        return depsOnly;
    }

    private getModuleModelsByName(): Map<string, ModuleModel> {
        return new Map(this.currentModuleModels.map((m) => [m.moduleName ?? '', m]));
    }

    /** 全量/增量时为每个 ModuleDependencyInfo 设置 type：新增 'add'，删除 'delete'，未变动不设 */
    private markDependencyTypesIncremental(depsOnly: DepsOnlyItem[]): void {
        const byName = this.getModuleModelsByName();
        const lastByName = new Map(this.lastDepsOnlyForDiff.map((d) => [d.moduleName ?? '', d]));

        for (const item of depsOnly) {
            const name = item.moduleName ?? '';
            const { oldDeps, oldDynamic } = this.getOldDepsForModule(name, byName, lastByName);
            const newDeps = item.dependencies ?? {};
            const newDynamic = item.dynamicDependencies ?? {};

            this.markAddAndDeleteInDeps(oldDeps, newDeps, (key, old) => {
                (item.dependencies ??= {})[key] = this.makeDeleteEntry(key, old);
            });
            this.markAddAndDeleteInDeps(oldDynamic, newDynamic, (key, old) => {
                (item.dynamicDependencies ??= {})[key] = this.makeDeleteEntry(key, old);
            });
        }
    }

    /** 取某模块的“旧”依赖：优先 byName，否则用 lastByName */
    private getOldDepsForModule(
        moduleName: string,
        byName: Map<string, ModuleModel>,
        lastByName: Map<string, DepsOnlyItem>,
    ): { oldDeps: Record<string, ModuleDependencyInfo>; oldDynamic: Record<string, ModuleDependencyInfo> } {
        const oldModule = byName.get(moduleName);
        let oldDeps = oldModule?.moduleDependencies?.dependencies ?? {};
        let oldDynamic = oldModule?.moduleDependencies?.dynamicDependencies ?? {};
        if (Object.keys(oldDeps).length === 0 && Object.keys(oldDynamic).length === 0) {
            const last = lastByName.get(moduleName);
            if (last) {
                oldDeps = last.dependencies ?? {};
                oldDynamic = last.dynamicDependencies ?? {};
            }
        }
        return { oldDeps, oldDynamic };
    }

    /** 对新 map 中新增的标 add，对旧有且新 map 没有的调用 onDelete 写入 delete 项 */
    private markAddAndDeleteInDeps(
        oldMap: Record<string, ModuleDependencyInfo>,
        newMap: Record<string, ModuleDependencyInfo>,
        onDelete: (key: string, old: ModuleDependencyInfo | undefined) => void,
    ): void {
        for (const key of Object.keys(newMap)) {
            if (!(key in oldMap)) {
                newMap[key].type = 'add';
            }
        }
        for (const key of Object.keys(oldMap)) {
            if (!(key in newMap)) {
                onDelete(key, oldMap[key]);
            }
        }
    }

    private makeDeleteEntry(name: string, old: ModuleDependencyInfo | undefined): ModuleDependencyInfo {
        return new ModuleDependencyInfo({
            name,
            version: old?.version ?? '',
            registryType: old?.registryType ?? 'ohpm',
            resolved: old?.resolved ?? '',
            type: 'delete',
        });
    }

    /** 从 depsOnly 单条创建最小化 ModuleModel（仅 name/path/deps） */
    private createMinimalModelFromDepsItem(item: DepsOnlyItem): ModuleModel {
        const model = new ModuleModel(item.modulePath);
        model.moduleName = item.moduleName;
        model.moduleType = item.moduleName;
        model.packageName = item.moduleName;
        model.moduleJsonParam = new ModuleJsonParam([]);
        model.modulePath = item.modulePath;
        model.moduleDependencies = item;
        return model;
    }

    /** 将 depsOnly 合并为模块列表：优先复用 byName 中已有 ModuleModel，否则新建。 */
    private mergeDepsOnlyIntoModuleList(depsOnly: DepsOnlyItem[], byName: Map<string, ModuleModel>): ModuleModel[] {
        const result: ModuleModel[] = [];
        for (const item of depsOnly) {
            const name = item.moduleName ?? '';
            let model = byName.get(name);
            if (!model) {
                model = this.createMinimalModelFromDepsItem(item);
            } else {
                model.modulePath = item.modulePath;
                model.moduleDependencies = item;
            }
            result.push(model);
        }
        return result;
    }

    /** 增量：从当前列表去掉 removed，用 depsOnly 更新/追加对应模块 */
    private mergeIncrementalDeps(
        current: ModuleModel[],
        removedSet: Set<string>,
        depsOnly: DepsOnlyItem[],
    ): ModuleModel[] {
        const depsMap = new Map(depsOnly.map((d) => [d.moduleName ?? '', d]));
        const result: ModuleModel[] = [];
        for (const m of current) {
            const name = m.moduleName ?? '';
            if (removedSet.has(name)) {
                continue;
            }
            const item = depsMap.get(name);
            if (item) {
                m.modulePath = item.modulePath;
                m.moduleDependencies = item;
                depsMap.delete(name);
            }
            result.push(m);
        }
        for (const [, item] of depsMap) {
            result.push(this.createMinimalModelFromDepsItem(item));
        }
        return result;
    }

    /** 更新 currentParams.modules 并填充路径 */
    private applyModuleModelsUpdate(moduleModels: ModuleModel[]): void {
        this.fillModuleModelsPaths(moduleModels);
        if (this.currentParams) {
            this.currentParams.initializationOptions.modules = moduleModels;
        }
    }

    /**
     * 根据 sdkPath 计算 SDK 相关路径，并填充到模块列表中。
     * start 与 reloadDependenciesOnly 共用。
     */
    private fillModuleModelsPaths(models: ModuleModel[]): void {
        const basePath = this.sdkPath;
        const aceLoaderPath = normalizePath(path.join(basePath, 'default/openharmony/ets/build-tools/ets-loader'));
        const sdkJsPath = normalizePath(path.join(basePath, 'default/openharmony/ets/api'));
        const hosSdkPath = normalizePath(path.join(basePath, 'default/hms'));

        for (const model of models) {
            model.aceLoaderPath = aceLoaderPath;
            model.sdkJsPath = sdkJsPath;
            model.hosSdkPath = hosSdkPath;
        }
    }

    sendRequest(msg: LspRequest) {
        switch (msg.method) {
            case LSP_METHOD.HOVER:
                this.handleHoverRequest(msg);
                break;
            case LSP_METHOD.DEFINITION:
                this.handleDefinitionRequest(msg);
                break;
            case LSP_METHOD.REFERENCES:
                this.handleReferencesRequest(msg);
                break;
            default:
                logger.warn(`Unhandled LSP request: ${msg.method}`);
        }
    }

    private handleHoverRequest(msg: LspRequest): void {
        const params = msg.params;
        if (!isRecord(params)) {
            logger.error('Invalid client textDocument/hover, params missing or not an object');
            return;
        }

        const { textDocument, position, requestId } = params;
        if (!isRecord(textDocument) || typeof textDocument.uri !== 'string' || !isPosition(position)) {
            logger.error('Invalid client textDocument/hover, malformed or missing required parameters');
            return;
        }

        if (typeof requestId !== 'number') {
            logger.error('Invalid client textDocument/hover, requestId missing or not a number');
            return;
        }

        this.registerRequestCallback(msg.id, requestId);
        this.messageHandle.sendAsyncRequest(
            LSP_METHOD.ON_ASYNC_HOVER,
            params,
            requestId,
            LSP_SEND_LABEL.ON_ASYNC_HOVER,
        );
    }

    private handleDefinitionRequest(msg: LspRequest): void {
        const params = msg.params;
        if (!isRecord(params)) {
            logger.error('Invalid client textDocument/definition, params missing or not an object');
            return;
        }

        const { textDocument, position } = params;
        if (!isRecord(textDocument) || typeof textDocument.uri !== 'string' || !isPosition(position)) {
            logger.error('Invalid client textDocument/definition, malformed or missing required parameters');
            return;
        }

        const requestIdNum = this.resolveRequestId(params.requestId, msg.id);
        if (!Number.isFinite(requestIdNum)) {
            logger.error('Invalid client textDocument/definition, requestId missing or not a valid number');
            return;
        }

        this.registerRequestCallback(msg.id, requestIdNum);
        this.messageHandle.sendAsyncRequest(
            LSP_METHOD.ON_ASYNC_DEFINITION,
            params,
            requestIdNum,
            LSP_SEND_LABEL.ON_ASYNC_DEFINITION,
        );
    }

    private handleReferencesRequest(msg: LspRequest): void {
        const params = msg.params;
        if (!isRecord(params)) {
            logger.error('Invalid client textDocument/references, params missing or not an object');
            return;
        }

        const { textDocument, position } = params;
        if (!isRecord(textDocument) || typeof textDocument.uri !== 'string' || !isPosition(position)) {
            logger.error('Invalid client textDocument/references, malformed or missing required parameters');
            return;
        }

        const requestIdNum = this.resolveRequestId(params.requestId, msg.id);
        if (!Number.isFinite(requestIdNum)) {
            logger.error('Invalid client textDocument/references, requestId missing or not a valid number');
            return;
        }

        this.registerRequestCallback(msg.id, requestIdNum);
        this.messageHandle.sendAsyncRequest(
            LSP_METHOD.ON_ASYNC_FIND_USAGES,
            params,
            requestIdNum,
            LSP_SEND_LABEL.ON_ASYNC_FIND_USAGES,
        );
    }

    private resolveRequestId(requestId: unknown, fallbackId: number | string): number {
        const raw = requestId ?? fallbackId;
        return typeof raw === 'number' ? raw : Number(raw);
    }

    sendNotification(msg: LspMessage) {
        if (!isNotificationRequest(msg)) {
            logger.info('LspServerProxy, msg is not notification request, ignore.');
            return;
        }

        switch (msg.method) {
            case LSP_METHOD.DID_OPEN:
                this.handleDidOpenNotification(msg);
                break;
            case LSP_METHOD.DID_CHANGE:
                this.handleDidChangeNotification(msg);
                break;
            case LSP_METHOD.DID_CLOSE:
                this.handleDidCloseNotification(msg);
                break;
            case LSP_METHOD.ON_DID_CHANGE_PACKAGE_DEPENDENCIES_CLIENT:
                this.handleDidChangePackageDependencies(msg);
                break;
            case LSP_METHOD.WORKSPACE_DID_CHANGE_WATCHED_FILES:
                this.handleDidChangeWatchedFiles(msg);
                break;
            default:
                logger.warn(`Unhandled LSP notification: ${msg.method}`);
        }
    }

    private handleDidOpenNotification(msg: LspNotification): void {
        const params = msg.params;
        if (!isRecord(params)) {
            logger.error('Invalid client textDocument/didOpen, params missing or not an object');
            return;
        }

        const { textDocument, editorFiles } = params;
        if (!isTextDocument(textDocument) || !isStringArray(editorFiles)) {
            logger.error('Invalid client textDocument/didOpen, malformed or missing required parameters');
            return;
        }

        const isFromEditor = typeof params.isFromEditor === 'boolean' ? params.isFromEditor : false;
        const openParam = { isFromEditor, editorFiles, textDocument };
        this.registerDiagnosticCallback(textDocument.uri);
        this.messageHandle.onAsyncOpenFile(openParam);
    }

    private handleDidChangeNotification(msg: LspNotification): void {
        const params = msg.params;
        if (!isRecord(params)) {
            logger.error('Invalid client textDocument/didChange, params missing or not an object');
            return;
        }

        const { textDocument, contentChanges } = params;
        if (
            !isRecord(textDocument) ||
            typeof textDocument.uri !== 'string' ||
            typeof textDocument.version !== 'number'
        ) {
            logger.error('Invalid client textDocument/didChange, malformed or missing required parameters');
            return;
        }

        if (!Array.isArray(contentChanges) || !contentChanges.every(isContentChange)) {
            logger.error('Invalid client textDocument/didChange, contentChanges invalid');
            return;
        }

        const uri = textDocument.uri;
        const version = textDocument.version;
        this.registerDiagnosticCallback(uri);
        this.messageHandle.onAsyncDidChange({ uri, version, contentChanges });
    }

    private handleDidCloseNotification(msg: LspNotification): void {
        const params = msg.params;
        if (!isRecord(params)) {
            logger.error('Invalid client textDocument/didClose, params missing or not an object');
            return;
        }

        const { textDocument } = params;
        if (!isRecord(textDocument) || typeof textDocument.uri !== 'string') {
            logger.error('Invalid client textDocument/didClose, malformed or missing required parameters');
            return;
        }

        const isManual = typeof params.isManual === 'boolean' ? params.isManual : false;
        this.messageHandle.closeFile(textDocument.uri, isManual);
    }

    private handleDidChangePackageDependencies(msg: LspNotification): void {
        const params = msg.params;
        if (!isRecord(params)) {
            logger.error(
                'Invalid client aceProject/onDidChangePakcageDependencies, params missing or not an object',
            );
            return;
        }

        const { moduleSet } = params;
        if (!Array.isArray(moduleSet) || moduleSet.length === 0) {
            logger.error(
                'Invalid client aceProject/onDidChangePakcageDependencies, malformed or missing required parameters',
            );
            return;
        }

        this.messageHandle.sendModuleDependencyUpdate(params);
    }

    private handleDidChangeWatchedFiles(msg: LspNotification): void {
        const params = msg.params;
        if (!isRecord(params)) {
            logger.error('Invalid client workspace/didChangeWatchedFiles, params missing or not an object');
            return;
        }

        const { changes } = params;
        if (!Array.isArray(changes)) {
            logger.error(
                'Invalid client workspace/didChangeWatchedFiles, malformed or missing required parameters',
            );
            return;
        }

        this.messageHandle.onDidChangeWatchedFiles(changes);
    }

    /**
     * 可重置超时：registerCallback 收到 (resolve, reset)。
     * 在等待期间每次调用 reset() 会重新开始计时；超时时间为 timeoutMs。
     */
    private withResettableTimeout(
        registerCallback: (resolve: () => void, reset: () => void) => void,
        operationName: string,
        timeoutMs: number,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            let timeoutId: ReturnType<typeof setTimeout>;

            const schedule = () => {
                timeoutId = setTimeout(() => {
                    reject(new Error(`${operationName} timeout after ${timeoutMs}ms`));
                }, timeoutMs);
            };

            const reset = () => {
                clearTimeout(timeoutId);
                schedule();
            };

            schedule();
            registerCallback(() => {
                clearTimeout(timeoutId);
                resolve();
            }, reset);
        });
    }

    async dispose(): Promise<void> {
        await this.messageHandle.stop();
    }
}
