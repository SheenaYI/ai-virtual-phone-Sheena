// lib/memory-service.ts
// High-level memory orchestration: retrieve long-term memories for prompt injection.

import type { MemoryConfig, MemoryEntry, MemoryRoom } from "./memory-types";
import { loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { MEMORY_ROOMS, resolveRoomBudgets, normalizeRoomFlags } from "./memory-room";

/** 单条记忆注入时的固定开销（换行等），与 fillByBudget 保持一致 */
const ENTRY_OVERHEAD = 4;

function entryTokens(entry: MemoryEntry): number {
    return estimateTokens(entry.content) + ENTRY_OVERHEAD;
}

function totalTokens(entries: MemoryEntry[]): number {
    let total = 0;
    for (const entry of entries) total += entryTokens(entry);
    return total;
}

/**
 * Retrieve relevant long-term memories for prompt injection.
 *
 * 旧行为（记忆宫殿关闭 / 房间未启用 / 模式为 global）：
 *   1. Total tokens <= longTermTokenBudget → return all
 *   2. Over budget + embedding API configured → vector-rank, fill until budget
 *   3. Over budget + no embedding → time-sorted (newest first), fill until budget
 *
 * 记忆宫殿（roomEnabled && roomTruncationMode === "perRoom"）：
 *   每个房间一个预算；常驻房间优先占位；房间内按 置顶 > 重要度×时间衰减(×相关性) 排序；
 *   longTermTokenBudget 仍作为全局硬护栏，超出时从非常驻房间的最低分条目开始剔除。
 * Embedding API is resolved from auxiliary binding (global, not per-character).
 */
export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;

    // Calculate total tokens for all entries
    const allTokens = totalTokens(longTermEntries);

    // Strategy 1: all fit within budget → return all
    if (allTokens <= budget) {
        return sortForInjection(longTermEntries, config);
    }

    // 记忆宫殿：分房间预算
    if (config.roomEnabled && config.roomTruncationMode === "perRoom") {
        return selectByRoomBudget(longTermEntries, currentContext, config, budget);
    }

    // Strategy 2: vector recall enabled + embedding API configured → vector search, fill by relevance
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
        if (queryEmbedding) {
            const withEmbeddings = longTermEntries.filter(m => m.embedding && m.embedding.length > 0);
            if (withEmbeddings.length > 0) {
                const scored = withEmbeddings.map(entry => ({
                    entry,
                    score: cosineSimilarity(queryEmbedding, entry.embedding!),
                }));
                scored.sort((a, b) => b.score - a.score);
                return fillByBudget(scored.map(s => s.entry), budget);
            }
        }
    }

    // Strategy 3: no embedding support → newest first, fill by budget
    const sorted = [...longTermEntries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return fillByBudget(sorted, budget);
}

/** 全部都在预算内时的输出顺序：按房间分组、房间固定顺序、未归档垫底。 */
function sortForInjection(entries: MemoryEntry[], config: MemoryConfig): MemoryEntry[] {
    if (!config.roomEnabled) return entries;
    const ordered: MemoryEntry[] = [];
    for (const room of MEMORY_ROOMS) {
        for (const entry of entries) {
            if (entry.room === room) ordered.push(entry);
        }
    }
    for (const entry of entries) {
        if (!entry.room) ordered.push(entry);
    }
    return ordered.length === entries.length ? ordered : entries;
}

/** 时间衰减：半衰期约一个月（分数 0-1）。 */
function recencyScore(entry: MemoryEntry, nowMs: number): number {
    const created = new Date(entry.createdAt).getTime();
    if (!Number.isFinite(created)) return 0.5;
    const ageDays = Math.max(0, (nowMs - created) / 86_400_000);
    return 1 / (1 + ageDays / 30);
}

type ScoredEntry = { entry: MemoryEntry; score: number; tokens: number };

function scoreEntries(
    entries: MemoryEntry[],
    relevanceById: Map<string, number> | null,
    nowMs: number,
): ScoredEntry[] {
    return entries.map(entry => {
        const importance = Number.isFinite(entry.importance) ? entry.importance : 0.8;
        const recency = recencyScore(entry, nowMs);
        const hasRelevance = relevanceById?.has(entry.id) === true;
        const relevance = hasRelevance ? relevanceById!.get(entry.id)! : 0.5;
        const score = hasRelevance
            ? importance * 0.45 + recency * 0.3 + relevance * 0.25
            : importance * 0.6 + recency * 0.4;
        return { entry, score, tokens: entryTokens(entry) };
    });
}

/** 房间内排序：置顶永远最先，其次按分数；同分按时间新到旧。 */
function sortScored(items: ScoredEntry[]): ScoredEntry[] {
    return [...items].sort((a, b) => {
        const aPinned = a.entry.pinned ? 1 : 0;
        const bPinned = b.entry.pinned ? 1 : 0;
        if (aPinned !== bPinned) return bPinned - aPinned;
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.entry.createdAt).getTime() - new Date(a.entry.createdAt).getTime();
    });
}

/** 按房间预算挑选；全局 longTermTokenBudget 作为硬护栏。 */
async function selectByRoomBudget(
    entries: MemoryEntry[],
    currentContext: string,
    config: MemoryConfig,
    globalBudget: number,
): Promise<MemoryEntry[]> {
    const nowMs = Date.now();
    const budgets = resolveRoomBudgets(config);
    const residentFlags = normalizeRoomFlags(config.roomResident);

    // 相关性只用一次 embedding 调用（不为每个房间各调一次）
    let relevanceById: Map<string, number> | null = null;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
            if (queryEmbedding) {
                const map = new Map<string, number>();
                for (const entry of entries) {
                    if (!entry.embedding || entry.embedding.length === 0) continue;
                    map.set(entry.id, cosineSimilarity(queryEmbedding, entry.embedding));
                }
                if (map.size > 0) relevanceById = map;
            }
        } catch {
            relevanceById = null;
        }
    }

    const buckets: Array<{ room?: MemoryRoom; resident: boolean; budget: number; items: ScoredEntry[] }> = [];
    for (const room of MEMORY_ROOMS) {
        const roomEntries = entries.filter(entry => entry.room === room);
        if (roomEntries.length === 0) continue;
        buckets.push({
            room,
            resident: residentFlags[room] === true,
            budget: budgets[room],
            items: sortScored(scoreEntries(roomEntries, relevanceById, nowMs)),
        });
    }
    const unfiled = entries.filter(entry => !entry.room);
    if (unfiled.length > 0) {
        buckets.push({
            room: undefined,
            resident: false,
            budget: budgets.living,
            items: sortScored(scoreEntries(unfiled, relevanceById, nowMs)),
        });
    }

    type RoomPick = { room?: MemoryRoom; resident: boolean; item: ScoredEntry; roomIndex: number };
    const picks: RoomPick[] = [];

    // 第一轮：每个房间按自己的预算装满（置顶条目总是保留）
    buckets.forEach((bucket, roomIndex) => {
        let used = 0;
        for (const item of bucket.items) {
            const pinned = item.entry.pinned === true;
            if (!pinned && bucket.budget > 0 && used + item.tokens > bucket.budget) break;
            if (!pinned && bucket.budget <= 0) break;
            picks.push({ room: bucket.room, resident: bucket.resident, item, roomIndex });
            used += item.tokens;
        }
    });

    // 第二轮：全局硬护栏——超出时从非常驻房间的最低分条目开始剔除
    let grand = picks.reduce((sum, pick) => sum + pick.item.tokens, 0);
    if (grand > globalBudget) {
        const droppable = [...picks]
            .filter(pick => !pick.resident && pick.item.entry.pinned !== true)
            .sort((a, b) => a.item.score - b.item.score);
        const dropped = new Set<ScoredEntry>();
        for (const pick of droppable) {
            if (grand <= globalBudget) break;
            dropped.add(pick.item);
            grand -= pick.item.tokens;
        }
        const survivors = picks.filter(pick => !dropped.has(pick.item));
        // 极端情况：剔除后仍然超预算（全是常驻/置顶），保留常驻、按时序截断
        const finalPicks = survivors.length > 0 ? survivors : picks;
        let finalTotal = finalPicks.reduce((sum, pick) => sum + pick.item.tokens, 0);
        const ordered = finalPicks.map(pick => pick.item.entry);
        if (finalTotal > globalBudget) {
            return truncateOldestFirst(ordered, globalBudget);
        }
        return ordered;
    }

    return picks.map(pick => pick.item.entry);
}

/** 兜底：整体超预算时按时间从最旧开始丢，直到装得下。 */
function truncateOldestFirst(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const sorted = [...entries].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return fillByBudget(sorted, budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((a, b) => {
        const aActive = a.metadata?.active ? 1 : 0;
        const bActive = b.metadata?.active ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        const aDate = String(a.metadata?.eventDate ?? a.updatedAt ?? a.createdAt);
        const bDate = String(b.metadata?.eventDate ?? b.updatedAt ?? b.createdAt);
        return bDate.localeCompare(aDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

/** Pick entries in order until token budget is exhausted. */
function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = entryTokens(entry);
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
