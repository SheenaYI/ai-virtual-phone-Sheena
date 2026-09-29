// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.
//
// 记忆宫殿：一次调用产出多个房间的段落（[客厅] / [卧室] …），每个有内容的房间存成一条
// 独立 long_term（带 room 标签）。房间开关关闭时，行为与旧版一致：整段存成一条。

import type { MemoryEntry, MemoryRoom } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { loadNativeTimeline, formatTimelineForSummarization, filterTimelineByAllowedSources } from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";
import { buildRoomSpecText, parseRoomSections, ROOM_ENTRY_LIMIT_MULTIPLIER } from "./memory-room";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/** 组装长期记忆总结提示词：替换占位符 + 注入房间规则。 */
function buildSummaryPrompt(params: {
    template: string;
    characterName: string;
    earliest: string;
    latest: string;
    eventsText: string;
    roomSpec: string;
}): string {
    let prompt = params.template
        .replace(/\{\{char\}\}/gi, params.characterName)
        .replace(/\{\{earliest\}\}/gi, params.earliest)
        .replace(/\{\{latest\}\}/gi, params.latest)
        .replace(/\{\{roomSpec\}\}/gi, params.roomSpec)
        .replace(/\{\{events\}\}/gi, params.eventsText);

    // 用户自己的模板没有 {{roomSpec}} 时，把房间规则附在末尾，
    // 免得"开了记忆宫殿却完全没告诉模型要分房间"。
    if (params.roomSpec && !/\{\{\s*roomSpec\s*\}\}/i.test(params.template)) {
        prompt = `${prompt.trim()}\n\n${params.roomSpec}`;
    }
    // 占位符解析成空串可能留下多余空行
    return prompt.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string; savedCount?: number }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    const allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );

    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const { eventsText, earliest, latest } = formatted;

    const promptTemplate = config.summarizationPrompt?.trim() || DEFAULT_SUMMARIZATION_PROMPT;
    const roomSpec = config.roomEnabled ? buildRoomSpecText(config) : "";
    const summaryPrompt = buildSummaryPrompt({
        template: promptTemplate,
        characterName,
        earliest,
        latest,
        eventsText,
        roomSpec,
    });

    // Call LLM for summarization — compatible with all providers
    // label 用于在「底层调用大模型日志」中标识这是记忆总结调用
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: summaryPrompt }],
        { temperature: 0.3, label: `记忆总结·${characterName}`, allowReasoningFallback: false },
    );

    if (!result.content) {
        return { success: false, error: result.error || "LLM 返回了空内容" };
    }

    if (result.wasTruncated) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限" };
    }

    const summary = result.content;

    // Generate embedding for the summary (only if vector recall is enabled)
    let embedding: number[] | undefined;
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const emb = await generateEmbedding(summary, embeddingApiConfig);
            if (emb) embedding = emb;
        } catch { /* ignore */ }
    }

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));

    const now = new Date().toISOString();
    // 所有拆出来的条目共享同一份 metadata（尤其是 sourceSessionIds：
    // 共创的「按会话删除长期记忆」靠它找条目，漏复制就会删不干净）
    const sharedMetadata: Record<string, unknown> = {
        summarizedEvents: allEntries.length,
        timeSpan: `${earliest} ~ ${latest}`,
        sourceSessionIds,
    };

    const sections = config.roomEnabled
        ? parseRoomSections(summary)
        : [{ room: undefined as MemoryRoom | undefined, content: summary }];

    const usable = sections.filter(section => section.content.trim());
    if (usable.length === 0) {
        return { success: false, error: "记忆总结结果为空" };
    }

    const savedEntries: MemoryEntry[] = [];
    for (const section of usable) {
        const sectionEmbedding = usable.length === 1
            ? embedding
            : await buildSectionEmbedding(section.content, config);
        const entry: MemoryEntry = {
            id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            sourceApp: dominantSource as MemoryEntry["sourceApp"],
            type: "long_term",
            content: section.content,
            embedding: sectionEmbedding,
            importance: 0.8,
            createdAt: now,
            updatedAt: now,
            ...(section.room ? { room: section.room } : {}),
            metadata: { ...sharedMetadata },
        };
        await saveMemoryEntry(entry);
        savedEntries.push(entry);
    }

    // Update last summarized timestamp + reset counter
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    // Enforce long-term limit
    await enforceLongTermLimit(characterId, config);

    incrementCoreMemoryCounter(characterId);
    await maybeRunCoreMemoryPipeline(characterId, characterName);

    console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → ${savedEntries.length} long-term memory`);
    return { success: true, savedCount: savedEntries.length };
}

/** 拆条后为单条生成 embedding（失败静默忽略，不影响入库）。 */
async function buildSectionEmbedding(
    content: string,
    config: ReturnType<typeof loadMemoryConfig>,
): Promise<number[] | undefined> {
    const embeddingApiConfig = config.vectorRecallEnabled ? resolveAuxiliaryApiConfig("embeddingApiConfigId") : null;
    if (!embeddingApiConfig || !resolveEmbeddingModel(embeddingApiConfig)) return undefined;
    try {
        return (await generateEmbedding(content, embeddingApiConfig)) ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * 超出 maxLongTermEntries 时的淘汰。
 *
 * 记忆宫殿开启：按「重要度 × 时间衰减」从低到高淘汰，置顶条目豁免
 *   ——否则收藏室/自我房间的老条目会被新记忆整批冲掉。
 * 关闭：保持旧行为（按 createdAt 从最旧开始删）。
 *
 * 注：这里只加载 long_term。旧实现用 loadMemoryEntries()（含 core），
 * 长期记忆超额时会连带删掉核心记忆，属数据丢失隐患，一并修正。
 */
async function enforceLongTermLimit(
    characterId: string,
    config: ReturnType<typeof loadMemoryConfig>,
): Promise<void> {
    // 房间化后单次总结产出多条，有效上限按倍数放宽，避免历史被加速淘汰
    const effectiveLimit = config.roomEnabled
        ? Math.max(config.maxLongTermEntries, Math.round(config.maxLongTermEntries * ROOM_ENTRY_LIMIT_MULTIPLIER))
        : config.maxLongTermEntries;

    const longTerm = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTerm.length <= effectiveLimit) return;

    const excessCount = longTerm.length - effectiveLimit;
    if (!config.roomEnabled) {
        const byOldest = [...longTerm].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const excess = byOldest.slice(0, excessCount);
        await deleteMemoryEntries(excess.map(e => e.id));
        return;
    }

    const nowMs = Date.now();
    const droppable = longTerm
        .filter(entry => entry.pinned !== true)
        .map(entry => ({
            id: entry.id,
            score: (Number.isFinite(entry.importance) ? entry.importance : 0.8)
                * (1 / (1 + Math.max(0, (nowMs - new Date(entry.createdAt).getTime()) / 86_400_000) / 30)),
        }))
        .sort((a, b) => a.score - b.score);

    const excess = droppable.slice(0, excessCount);
    if (excess.length === 0) return; // 全被置顶，宁可不删
    await deleteMemoryEntries(excess.map(e => e.id));
}
