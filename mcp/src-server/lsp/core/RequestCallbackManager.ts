/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { logger } from '../logger.js';

/** 异步请求完成时的回调：(method, payload) => void */
export type RequestCallback = (method: string, payload: unknown) => void;

export type RequestCallbackKey = string | number;

/**
 * 通用请求回调与超时管理：按 key（如 uri、requestId）注册回调，
 * 在收到完成信号时触发，或超时后执行 onTimeout。
 */
export class RequestCallbackManager {
    private readonly callbacks = new Map<RequestCallbackKey, RequestCallback>();
    private readonly timeouts = new Map<RequestCallbackKey, NodeJS.Timeout>();

    /** 注册回调：该 key 完成时会被调用（并清除超时）。 */
    register(key: RequestCallbackKey, callback: RequestCallback): void {
        this.callbacks.set(key, callback);
    }

    /**
     * 触发完成：执行回调、清除该 key 的超时并移除注册。
     */
    emit(key: RequestCallbackKey, method: string, payload: unknown): void {
        logger.info(`[RequestCallbackManager] emit, method: ${method}, key: ${key}`);
        this.clearTimeout(key);
        const cb = this.callbacks.get(key);
        if (cb) {
            cb(method, payload);
            this.callbacks.delete(key);
        }
    }

    /**
     * 为该 key 注册超时：timeoutMs 后执行 onTimeout，并移除该 key 的超时句柄。
     * 若在超时前 emit(key, ...)，会先清除该超时。
     */
    registerTimeout(key: RequestCallbackKey, method: string, timeoutMs: number, onTimeout: () => void): void {
        if (this.timeouts.has(key)) {
            clearTimeout(this.timeouts.get(key)!);
        }
        const timeout = setTimeout(() => {
            logger.info(`[RequestCallbackManager] timeout, key=${key}, method=${method}`);
            onTimeout();
            this.timeouts.delete(key);
        }, timeoutMs);
        this.timeouts.set(key, timeout);
    }

    clearTimeout(key: RequestCallbackKey): void {
        const timer = this.timeouts.get(key);
        if (timer) {
            clearTimeout(timer);
            this.timeouts.delete(key);
        }
    }

    deleteCallback(key: RequestCallbackKey): void {
        this.callbacks.delete(key);
    }

    hasCallback(key: RequestCallbackKey): boolean {
        return this.callbacks.has(key);
    }

    /** 清除该 key 的回调与超时。 */
    clear(key: RequestCallbackKey): void {
        this.clearTimeout(key);
        this.callbacks.delete(key);
    }
}
