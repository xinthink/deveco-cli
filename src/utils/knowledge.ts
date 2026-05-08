/*
 * Copyright (c) 2026 Huawei Device Co., Ltd.
 * SPDX-License-Identifier: MIT
 */

import { stringSimilarity } from 'string-similarity-js';
import { debugLog } from './logger.js';
import { loginService } from '../auth/login-service.js';

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
 * 使用 Sørensen-Dice 系数计算字符串相似度（基于 string-similarity-js，~700 bytes）
 * Dice = 2|A ∩ B| / (|A| + |B|)，比 Jaccard 对短文本更敏感
 */
function diceSimilarity(textA: string, textB: string): number {
    if (!textA || !textB) {
        return 0;
    }
    return stringSimilarity(textA.toLowerCase(), textB.toLowerCase());
}

/**
 * 计算 BM25 分数（单文档对单 query）
 * BM25 是信息检索领域经典算法，比 TF-IDF 更适合短文本检索
 * @param k1 词频饱和参数，通常 1.2~2.0
 * @param b 文档长度归一化参数，通常 0.75
 */
function bm25Score(
    queryTokens: string[],
    docTokens: string[],
    avgDocLen: number,
    docFreqMap: Map<string, number>,
    totalDocs: number,
    k1 = 1.5,
    b = 0.75,
): number {
    if (docTokens.length === 0 || queryTokens.length === 0) {
        return 0;
    }

    const docLen = docTokens.length;
    const termFreq = new Map<string, number>();
    for (const term of docTokens) {
        termFreq.set(term, (termFreq.get(term) ?? 0) + 1);
    }

    let score = 0;
    for (const term of new Set(queryTokens)) {
        const tf = termFreq.get(term) ?? 0;
        if (tf === 0) {
            continue;
        }

        const df = docFreqMap.get(term) ?? 0;
        // IDF with smoothing: log((N - df + 0.5) / (df + 0.5) + 1)
        const idf = Math.log((totalDocs - df + 0.5) / (df + 0.5) + 1);
        // BM25 term score
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen)));
        score += idf * tfNorm;
    }
    return score;
}

/**
 * 混合相似度计算器：结合 BM25 + Jaccard + 关键词命中率
 * 轻量级实现，无外部依赖
 */
class HybridSimilarity {
    private docTexts: string[];
    private titles: string[] | null = null;
    private docTokens: string[][];
    private avgDocLen: number;
    private docFreqMap: Map<string, number>;
    private totalDocs: number;

    constructor(documents: string[], titles?: string[]) {
        this.docTexts = documents;
        this.titles = titles || null;
        this.docTokens = documents.map((d) => tokenizeMixed(d));
        this.totalDocs = documents.length;

        // 计算平均文档长度
        const totalLen = this.docTokens.reduce((sum, tokens) => sum + tokens.length, 0);
        this.avgDocLen = this.totalDocs > 0 ? totalLen / this.totalDocs : 0;

        // 计算文档频率 (DF)
        this.docFreqMap = new Map<string, number>();
        for (const tokens of this.docTokens) {
            const seen = new Set(tokens);
            for (const term of seen) {
                this.docFreqMap.set(term, (this.docFreqMap.get(term) ?? 0) + 1);
            }
        }
    }

    /**
     * 计算综合相似度分数
     * @returns 包含各维度分数的详细结果
     */
    getSimilarityDetail(query: string, docIndex: number): SimilarityDetail {
        const queryTokens = tokenizeMixed(query);
        const docToks = this.docTokens[docIndex];
        const docText = this.docTexts[docIndex];
        const titleText = this.titles?.[docIndex] || '';

        // 1. BM25 原始分数（信息检索核心算法）
        const rawBm25 = bm25Score(
            queryTokens,
            docToks,
            this.avgDocLen,
            this.docFreqMap,
            this.totalDocs,
        );

        // 2. Dice 系数：基于 bigram 的字符串相似度（string-similarity-js，~700bytes）
        //    对短查询更敏感，能区分字符级别的相似
        const dice = diceSimilarity(query, docText.slice(0, 500));

        // 3. 标题 Dice 匹配（标题通常高度概括文档主题）
        const titleDice = titleText ? diceSimilarity(query, titleText) : 0;

        // 4. Query 覆盖率：query 中有多少词在文档中出现
        const docTokenSet = new Set(docToks);
        const queryUnique = new Set(queryTokens);
        let hitCount = 0;
        for (const term of queryUnique) {
            if (docTokenSet.has(term)) {
                hitCount++;
            }
        }
        const coverage = queryUnique.size > 0 ? hitCount / queryUnique.size : 0;

        // 5. 位置权重：查询词在文档开头出现的加成
        const positionBoost = this.calcPositionBoost(queryTokens, docToks);

        // 综合分数（权重经验调参）：
        // - titleDice 40%：标题匹配最重要，能快速定位主题
        // - dice 25%：内容的字符级相似度
        // - BM25 20%：词频统计提供基础排序
        // - coverage 10%：查询词覆盖率
        // - positionBoost 5%：位置权重微调
        const combined =
            titleDice * 0.40 +
            dice * 0.25 +
            Math.min(rawBm25 / 10, 1) * 0.20 +
            coverage * 0.10 +
            positionBoost * 0.05;

        return {
            bm25Raw: rawBm25,
            dice,
            titleDice,
            coverage,
            positionBoost,
            combined,
            queryTokenCount: queryTokens.length,
            docTokenCount: docToks.length,
            hitTerms: hitCount,
        };
    }

    /**
     * 计算位置权重：查询词越靠近文档开头，权重越高
     */
    private calcPositionBoost(queryTokens: string[], docTokens: string[]): number {
        if (docTokens.length === 0 || queryTokens.length === 0) {
            return 0;
        }

        const querySet = new Set(queryTokens);
        let totalBoost = 0;
        let matchCount = 0;

        for (let i = 0; i < docTokens.length; i++) {
            if (querySet.has(docTokens[i])) {
                // 位置越靠前，boost 越高（指数衰减）
                totalBoost += Math.exp(-i / 50);
                matchCount++;
            }
        }
        // 归一化：最大可能值约为 matchCount（当全在开头时）
        return matchCount > 0 ? Math.min(totalBoost / matchCount, 1) : 0;
    }

    getSimilarity(query: string, docIndex: number): number {
        return this.getSimilarityDetail(query, docIndex).combined;
    }
}

interface SimilarityDetail {
    bm25Raw: number;
    dice: number;
    titleDice: number;
    coverage: number;
    positionBoost: number;
    combined: number;
    queryTokenCount: number;
    docTokenCount: number;
    hitTerms: number;
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
export function normalizeBigSearchQuestion(content: string | string[] | undefined | null): string {
    if (content == null) {
        return '';
    }
    const joined = Array.isArray(content) ? content.join(' ') : content;
    return joined.replace(/\s+/g, ' ').trim();
}

const KNOWLEDGE_URL = 'https://cn.devecostudio.huawei.com/codeGenie/bigSearch';
export class Knowledge {
    /**
     * 混合相似度阈值（绝对值），∈ (0,1]。
     * 算法：titleDice×0.4 + dice×0.25 + BM25×0.2 + coverage×0.1 + positionBoost×0.05
     * - < 0.20: 几乎无关
     * - 0.20~0.30: 弱相关
     * - 0.30~0.40: 中等相关
     * - > 0.40: 强相关
     */
    public static SIMILARITY_THRESHOLD = 0.3;
    public static MAX_RANKING_LIST_SIZE = 10;
    private static _INSTANCE: Knowledge;
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

        const rawText = await response.text();
        const payload = this.parseBigSearchHttpResponse(response, rawText);

        const rankingList = payload.body.rankingList;
        const ranked = rankRankingListBySimilarity(content, rankingList);
        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            payload,
            ranked,
        };
    }

    private parseBigSearchHttpResponse(response: Response, rawText: string): BigSearchResponse {
        if (!response.ok || response.status !== 200) {
            throw new Error(
                `Failed to get big search response: HTTP ${response.status} ${response.statusText} body=${truncateForError(rawText)}`,
            );
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(rawText);
        } catch (err) {
            throw new Error(
                `Big search response is not valid JSON: ${truncateForError(rawText)}`,
                { cause: err },
            );
        }
        try {
            return parseBigSearchResponse(parsed);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`${msg} | raw=${truncateForError(rawText)}`, { cause: err });
        }
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
 * 4. 按相似度降序
 * 5. 取前 maxSize 条
 */
export function filterAndSortRankingList(
    list: LlmRanking[],
    maxSize = Knowledge.MAX_RANKING_LIST_SIZE,
    threshold = Knowledge.SIMILARITY_THRESHOLD,
): LlmRanking[] {
    return list
        .filter((item) => item.embed != null && item.embed.dimension > 0 && item.embed.similarity >= threshold)
        .sort((a, b) => (b.embed?.similarity ?? 0) - (a.embed?.similarity ?? 0))
        .slice(0, maxSize);
}

/**
 * 使用混合相似度（BM25 + Jaccard + 覆盖率）对 rankingList 排序。
 * 支持绝对阈值过滤，同时输出详细日志便于调参验证。
 */
function rankRankingListBySimilarity(
    content: string,
    rankingList: LlmRanking[],
): LlmRanking[] {
    if (rankingList.length === 0) {
        return [];
    }
    const docTexts = rankingList.map((item) => item.content);
    const titles = rankingList.map((item) => item.title || '');
    const maxSize = Knowledge.MAX_RANKING_LIST_SIZE;
    const threshold = Knowledge.SIMILARITY_THRESHOLD;
    const model = new HybridSimilarity(docTexts, titles);

    // 计算每个文档的详细相似度
    const withDetail = rankingList.map((item, i) => {
        const detail = model.getSimilarityDetail(content, i);
        const embed: LlmRankingEmbed = { dimension: docTexts.length, similarity: detail.combined };
        return { item: { ...item, embed }, detail, index: i };
    });

    // 按综合分数排序
    const sorted = [...withDetail].sort((a, b) => b.detail.combined - a.detail.combined);

    // 过滤达标项
    const passed = sorted.filter((entry) => entry.detail.combined >= threshold);
    const passedCount = passed.length;
    const minFallbackThreshold = 3;

    let ranked: LlmRanking[];
    if (passedCount >= maxSize) {
        ranked = passed.slice(0, maxSize).map((e) => e.item);
    } else if (passedCount >= minFallbackThreshold) {
        ranked = passed.map((e) => e.item);
    } else if (passedCount > 0) {
        ranked = passed.map((e) => e.item);
        for (const entry of sorted) {
            if (ranked.length >= minFallbackThreshold) {
                break;
            }
            if (!passed.includes(entry)) {
                ranked.push(entry.item);
            }
        }
    } else {
        ranked = sorted.slice(0, minFallbackThreshold).map((e) => e.item);
    }

    debugLog(`Knowledge ranking: ${rankingList.length} candidates, ${passedCount} passed (threshold=${threshold}), returning ${ranked.length}`);
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
    /** 本地 ranking 列表规模（非真实向量维数），与历史字段兼容。 */
    dimension: number;
    /** 混合相似度分数（BM25 + Jaccard + 覆盖率加权），范围 [0,1]。 */
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
