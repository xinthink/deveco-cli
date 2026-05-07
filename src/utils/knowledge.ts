/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import natural from 'natural';
import { debugLog } from './logger.js';
import { loginService } from '../auth/login-service.js';

const { TfIdf } = natural;

/** 截断响应体，避免错误信息过长污染终端。 */
function truncateForError(text: string, max = 500): string {
    if (text.length <= max) {
        return text;
    }
    return `${text.slice(0, max)}…(truncated, total ${text.length} chars)`;
}

/**
 * 中文分词：按字符拆分（简单但有效的中文处理）
 * 英文保持词级别分词
 */
function tokenizeMixed(text: string): string[] {
    const tokens: string[] = [];
    const normalized = text.toLowerCase();
    
    // 匹配连续英文单词或单个中文字符
    const regex = /[a-z0-9]+|[\u4e00-\u9fff]/g;
    let match;
    while ((match = regex.exec(normalized)) !== null) {
        tokens.push(match[0]);
    }
    return tokens;
}

/**
 * 基于 TF-IDF 的向量相似度计算器
 */
class TfIdfSimilarity {
    private tfidf: InstanceType<typeof TfIdf>;
    private documents: string[];
    private docVectors: Map<string, number>[];

    constructor(documents: string[]) {
        this.tfidf = new TfIdf();
        this.documents = documents;
        this.docVectors = [];

        // 添加所有文档到 TF-IDF 模型
        for (const doc of documents) {
            this.tfidf.addDocument(tokenizeMixed(doc));
        }

        // 预计算所有文档的 TF-IDF 向量
        for (let i = 0; i < documents.length; i++) {
            const vector = new Map<string, number>();
            this.tfidf.listTerms(i).forEach((item) => {
                vector.set(item.term, item.tfidf);
            });
            this.docVectors.push(vector);
        }
    }

    /**
     * 计算 query 与指定文档的余弦相似度
     */
    getSimilarity(query: string, docIndex: number): number {
        const queryTerms = tokenizeMixed(query);
        const queryVector = new Map<string, number>();

        // 计算 query 的 TF-IDF 向量（相对于语料库）
        for (const term of queryTerms) {
            const tf = queryTerms.filter((t) => t === term).length / queryTerms.length;
            // 使用语料库的 IDF
            let idf = 0;
            let docCount = 0;
            for (const docVec of this.docVectors) {
                if (docVec.has(term)) {
                    docCount++;
                }
            }
            if (docCount > 0) {
                idf = Math.log(this.documents.length / docCount);
            }
            queryVector.set(term, tf * idf);
        }

        // 计算余弦相似度
        const docVector = this.docVectors[docIndex];
        return this.cosineSim(queryVector, docVector);
    }

    private cosineSim(a: Map<string, number>, b: Map<string, number>): number {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;

        // 计算点积
        for (const [term, weight] of a) {
            if (b.has(term)) {
                dotProduct += weight * b.get(term)!;
            }
            normA += weight * weight;
        }

        for (const weight of b.values()) {
            normB += weight * weight;
        }

        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dotProduct / denom;
    }
}

export interface BigSearchAnswer {
    prompt: string;
    [key: string]: unknown;
}

/**
 * 将接口返回的 JSON 文本解析为 {@link BigSearchResponse}。
 */
export function parseBigSearchResponseText(raw: string): BigSearchResponse {
    let data: unknown;
    try {
        data = JSON.parse(raw) as unknown;
    } catch {
        throw new Error('Big search response is not valid JSON');
    }
    return parseBigSearchResponse(data);
}

/**
 * 校验并收窄为强类型。成功形态与打印内容一致：
 * `code === 200`、`success` 为布尔、`body.code === 0`、`body.answer.prompt` 为字符串、`body.rankingList` 为数组。
 */
export function parseBigSearchResponse(data: unknown): BigSearchResponse {
    if (data === null || typeof data !== 'object') {
        throw new Error('Big search: expected a JSON object');
    }
    const root = data as Record<string, unknown>;
    if (root.code !== 200) {
        throw new Error(`Big search: unexpected root code ${String(root.code)}`);
    }
    if (typeof root.success !== 'boolean') {
        throw new Error('Big search: expected boolean field success');
    }
    const body = root.body;
    if (body === null || typeof body !== 'object') {
        throw new Error('Big search: expected object body');
    }
    const b = body as Record<string, unknown>;
    if (b.code !== 0) {
        throw new Error(
            `Big search: business error body.code=${String(b.code)} desc=${String(b.desc ?? '')}`,
        );
    }
    if (typeof b.desc !== 'string') {
        throw new Error('Big search: expected string body.desc');
    }
    const answer = b.answer;
    if (answer === null || typeof answer !== 'object') {
        throw new Error('Big search: expected object body.answer');
    }
    const a = answer as Record<string, unknown>;
    if (typeof a.prompt !== 'string') {
        throw new Error('Big search: expected string body.answer.prompt');
    }
    if (!Array.isArray(b.rankingList)) {
        throw new Error('Big search: expected array body.rankingList');
    }
    return data as BigSearchResponse;
}

/** 规范化用户问题：variadic 拼接后压空白，避免多余空格影响检索。 */
export function normalizeBigSearchQuestion(content: string | string[]): string {
    const joined = Array.isArray(content) ? content.join(' ') : content;
    return joined.replace(/\s+/g, ' ').trim();
}

const KNOWLEDGE_URL = 'https://cn.devecostudio.huawei.com/codeGenie/bigSearch';
export class Knowledge {
    public static COSINE_SIMILARITY_THRESHOLD = 0.13;
    public static MAX_RANKING_LIST_SIZE = 10;
    public static MAX_CELL_NODE_TEXT_LENGTH = 100;
    private static _INSTANCE: Knowledge;
    private ragRetrievedContentCache: Map<string, LlmRanking[][]> = new Map();
    private constructor() {}

    public static getInstance(): Knowledge {
        if (!Knowledge._INSTANCE) {
            Knowledge._INSTANCE = new Knowledge();
        }
        return Knowledge._INSTANCE;
    }

    /**
     * 返回原始 Response 前，会在本地对 rankingList 做向量化相关度计算，
     * 过滤出 embed.dimension > 0 的条目，按余弦相似度降序，取前 MAX_RANKING_LIST_SIZE 条存入缓存。
     */
    async getBigSearchResponse(content: string): Promise<BigSearchResult> {
        if (!content || content.length === 0) {
            throw new Error('Content is required');
        }
        const userInfo = await loginService.getUserInfo();
        if (!userInfo || !userInfo.accessToken) {
            throw new Error('Please login first');
        }
        const headers: Record<string, string> = {
            Authorization: userInfo.accessToken,
            'Content-Type': 'application/json',
        };

        // 仅对整包 body 做一次 JSON.stringify；question 本身应是字符串字段，勿再 JSON.stringify(content)。
        const body = { question: content };
        const response = await fetch(KNOWLEDGE_URL, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
        debugLog(`Response: status=${response.status} ok=${response.ok} url=${response.url}`);

        const rawText = await response.text();
        if (!response.ok || response.status !== 200) {
            throw new Error(
                `Failed to get big search response: HTTP ${response.status} ${response.statusText} body=${truncateForError(rawText)}`,
            );
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(rawText);
        } catch {
            throw new Error(
                `Big search response is not valid JSON: ${truncateForError(rawText)}`,
            );
        }
        let payload: BigSearchResponse;
        try {
            payload = parseBigSearchResponse(parsed);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`${msg} | raw=${truncateForError(rawText)}`);
        }

        // 使用 TF-IDF + 余弦相似度计算 question 与每条结果的相关度
        const rankingList = payload.body.rankingList;
        const ranked = rankRankingListBySimilarity(content, rankingList);
        debugLog(`TF-IDF ranking done, ${ranked.length} ranked result(s)`);
        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            payload,
            ranked,
        };
    }

    /** 与 {@link parseBigSearchResponse} 等价，失败时返回 `false` 而非抛错。 */
    validateBigSearchResponse(data: unknown): boolean {
        try {
            parseBigSearchResponse(data);
            return true;
        } catch {
            return false;
        }
    }
}

/**
 * 过滤并排序 rankingList：
 * 1. 先判空（embed 不为 null）
 * 2. embed.dimension > 0（向量化成功）
 * 3. 过滤掉相似度低于阈值的结果（阈值为 0 时不做下限过滤，仅排序截断）
 * 4. 按余弦相似度降序
 * 5. 取前 maxSize 条
 */
export function filterAndSortRankingList(
    list: LlmRanking[],
    maxSize = Knowledge.MAX_RANKING_LIST_SIZE,
    threshold = Knowledge.COSINE_SIMILARITY_THRESHOLD,
): LlmRanking[] {
    return list
        .filter((item) => item.embed != null && item.embed.dimension > 0 && item.embed.similarity >= threshold)
        .sort((a, b) => (b.embed?.similarity ?? 0) - (a.embed?.similarity ?? 0))
        .slice(0, maxSize);
}

/**
 * 使用 TF-IDF + 余弦相似度对 rankingList 进行相关度排序
 */
function rankRankingListBySimilarity(
    content: string,
    rankingList: LlmRanking[],
): LlmRanking[] {
    if (rankingList.length === 0) {
        return [];
    }
    const docTexts = rankingList.map((item) => item.content);
    const tfidfModel = new TfIdfSimilarity(docTexts);

    const withSimilarity = rankingList.map((item, i) => {
        const similarity = tfidfModel.getSimilarity(content, i);
        const embed: LlmRankingEmbed = { dimension: docTexts.length, similarity };
        return { ...item, embed };
    });
    const threshold = Knowledge.COSINE_SIMILARITY_THRESHOLD;
    const maxSim = Math.max(
        ...withSimilarity.map((item) => item.embed!.similarity),
    );

    let ranked = filterAndSortRankingList(
        withSimilarity,
        Knowledge.MAX_RANKING_LIST_SIZE,
        threshold,
    );
    if (ranked.length === 0) {
        debugLog(
            `knowledge ranking: no hits >= threshold=${threshold} (max cosine=${maxSim.toFixed(4)}, n=${rankingList.length}); falling back to top ${Knowledge.MAX_RANKING_LIST_SIZE} by similarity`,
        );
        ranked = filterAndSortRankingList(
            withSimilarity,
            Knowledge.MAX_RANKING_LIST_SIZE,
            0,
        );
    }
    return ranked;
}

export interface BigSearchResponse {
    code: number;
    success: boolean;
    body: BigSearchRespBody;
}

export interface BigSearchRespBody {
    code: number;
    desc: string;
    answer: BigSearchAnswer;
    rankingList: LlmRanking[];
}

export interface LlmRankingEmbed {
    /** 向量维度，all-MiniLM-L6-v2 输出 384 维 */
    dimension: number;
    /** 与问题的余弦相似度，范围 [-1, 1]，越接近 1 越相似 */
    similarity: number;
}

export interface LlmRanking {
    content: string;
    query: string;
    title: string;
    url: string;
    siteName: string;
    /** 向量化结果，由本地模型填充后用于相关度排序 */
    embed?: LlmRankingEmbed;
    siteRank?: string;
    siteLogo?: string;
    metaData?: string;
}

/** getBigSearchResponse 的返回结构，包含原始响应元信息与已向量化排序的结果列表 */
export interface BigSearchResult {
    ok: boolean;
    status: number;
    statusText: string;
    payload: BigSearchResponse;
    ranked: LlmRanking[];
}
