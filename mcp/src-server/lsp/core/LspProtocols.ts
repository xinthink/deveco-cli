/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface LspDiagnostic {
    range: Range;
    severity?: number | string;
    code?: number | string;
    source?: string;
    message: string;
    severityStr?: string;
}

export interface PublishDiagnosticsParams {
    uri: string;
    version?: number;
    diagnostics: LspDiagnostic[];
}

export interface LspResponse {
    jsonrpc: string;
    id?: number | string;
    result?: unknown;
    error?: unknown;
}

export interface LspNotification {
    jsonrpc: string;
    method: string;
    params?: unknown;
}

export interface LspRequest {
    jsonrpc: string;
    id: number | string;
    method: string;
    params?: unknown;
}

export interface TextDocumentContentChangeEvent {
    range?: Range;
    rangeLength?: number;
    text: string;
}

export interface ContentChange {
    range: Range;
    text: string;
}

export interface DidChangeParam {
    contentChanges: ContentChange[];
    uri: string;
    version: number;
}
