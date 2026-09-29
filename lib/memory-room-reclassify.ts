// lib/memory-room-reclassify.ts
// 记忆宫殿：把已有长期记忆批量重新归档到房间。
//
// 只改 room 字段，**不重写记忆正文**——可安全重跑、失败无副作用。
// 必须分批：全量几千条一次性解析+处理会把 iOS Safari 内存顶爆（灰屏杀页）。

import type { MemoryConfig, MemoryEntry, MemoryRoom } from "./memory-types";
import { loadMemoryEntriesByType, patchMemoryEntries } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { MEMORY_ROOMS, MEMORY_ROOM_META, normalizeMemoryRoom } from "./memory-room";

/** 每批处理的条数（上限，避免单次请求过大） */
export const RECLASSIFY_BATCH_SIZE = 20;



export type ReclassifyProgress = {
    /** 已处理条数 */
    processed: number;
    /** 需要处理的参数总数 */
    total: number;
    /** 实际写入的条数 */
    updated: number;
    /** 跳过的条数（手动修改过 / 模型没给结论） */
    skipped: number;
};

export type ReclassifyResult = {
    success: boolean;
    error?: string;
    updated: number;
    skipped: number;
    total: number;
};

function isManualMemoryEntry(entry: MemoryEntry): boolean {
    const origin = String(entry.metadata?.origin ?? "");
    return origin === "user_manual" || origin === "user_edited" || entry.id.includes("_manual_");
}

function buildReclassifyPrompt(characterName: string, batch: MemoryEntry[]): string {
    const lines: string[] = [];
    lines.push(`你是记忆归档助手。下面是为「${characterName}」整理的长期记忆条目，请为每一条选择最贴切的房间。`);
    lines.push("");
    lines.push("【房间定义】");
    for (const room of MEMORY_ROOMS) {
        const meta = MEMORY_ROOM_META[room];
        lines.push(`- ${room}（${meta.label}）：${meta.desc}`);
    }
    lines.push("");
    lines.push("【记忆条目】");
    for (const entry of batch) {
        lines.push(`${entry.id} | ${entry.content.replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
    lines.push("【要求】");
    lines.push("- 每条只选一个房间，用房间的英文 id（living/bedroom/collection/self/study/windowsill）");
    lines.push("- 无法判断的条目，room 留空字符串");
    lines.push("- 严格只输出 JSON 数组，不要输出解释、不要加代码块标记");
    lines.push("");
    lines.push("【输出格式】");
    lines.push('[{"id":"记忆id","room":"living"},{"id":"记忆id2","room":""}]');
    return lines.join("\n");
}

type RoomAssignment = { id: string; room?: MemoryRoom };

/** 尽力从模型输出里解析出 id → 房间 的映射（兼容 JSON 与朴素行格式）。 */
function parseAssignments(raw: string): RoomAssignment[] {
    const text = String(raw ?? "").trim();
    if (!text) return [];

    const cleaned = text
        .replace(/^```(?:json)?/i, "")
        .replace(/```$/i, "")
        .trim();

    const coerce = (value: unknown): RoomAssignment[] => {
        if (Array.isArray(value)) {
            const result: RoomAssignment[] = [];
            for (const item of value) {
                if (!item || typeof item !== "object") continue;
                const record = item as Record<string, unknown>;
                const id = String(record.id ?? record.memoryId ?? "").trim();
                if (!id) continue;
                result.push({ id, room: normalizeMemoryRoom(record.room ?? record.roomId) });
            }
            return result;
        }
        if (value && typeof value === "object") {
            const result: RoomAssignment[] = [];
            for (const [key, rawRoom] of Object.entries(value as Record<string, unknown>)) {
                result.push({ id: key.trim(), room: normalizeMemoryRoom(rawRoom) });
            }
            return result;
        }
        return [];
    };

    const jsonStart = cleaned.search(/[[{]/);
    if (jsonStart >= 0) {
        const candidate = cleaned.slice(jsonStart);
        try {
            const parsed = coerce(JSON.parse(candidate) as unknown);
            if (parsed.length > 0) return parsed;
        } catch {
            // 尝试截到最后一个闭合括号再解析一次
            const lastBrace = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
            if (lastBrace > 0) {
                try {
                    const parsed = coerce(JSON.parse(candidate.slice(0, lastBrace + 1)) as unknown);
                    if (parsed.length > 0) return parsed;
                } catch { /* fallthrough */ }
            }
        }
    }

    // 朴素行：id | room  或  id: room
    const result: RoomAssignment[] = [];
    for (const line of cleaned.split("\n")) {
        const match = line.match(/^\s*[-*\d.、"']*\s*(mem_[A-Za-z0-9_]+)\s*[|:：,，]\s*(.*)$/);
        if (!match) continue;
        result.push({ id: match[1], room: normalizeMemoryRoom(match[2]) });
    }
    return result;
}

/**
 * 批量重新归档房间。
 * - scope="unassigned"（默认）：只处理未归档条目，不动已有房间的条目
 * - scope="all"：重新判定所有条目
 * - force=false 时，跳过用户手动新增/编辑过的条目（config.reclassifySkipManual）
 */
export async function reclassifyMemoryRooms(
    characterId: string,
    characterName: string,
    config: MemoryConfig,
    options?: {
        scope?: "unassigned" | "all";
        /** true = 连手动修改过的条目也覆盖 */
        includeManual?: boolean;
        onProgress?: (progress: ReclassifyProgress) => void;
    },
): Promise<ReclassifyResult> {
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）", updated: 0, skipped: 0, total: 0 };
    }

    const scope = options?.scope ?? "unassigned";
    const includeManual = options?.includeManual === true || config.reclassifySkipManual === false;

    const all = await loadMemoryEntriesByType(characterId, "long_term");
    if (all.length === 0) {
        return { success: false, error: "没有可用于归档的长期记忆", updated: 0, skipped: 0, total: 0 };
    }

    const candidates = all.filter(entry => {
        if (scope === "unassigned" && entry.room) return false;
        if (!includeManual && isManualMemoryEntry(entry)) return false;
        return true;
    });

    const skippedByManual = all.filter(entry => !candidates.includes(entry)).length;

    if (candidates.length === 0) {
        return {
            success: true,
            updated: 0,
            skipped: skippedByManual,
            total: 0,
        };
    }

    let processed = 0;
    let updated = 0;
    let skipped = skippedByManual;

    for (let start = 0; start < candidates.length; start += RECLASSIFY_BATCH_SIZE) {
        const batch = candidates.slice(start, start + RECLASSIFY_BATCH_SIZE);
        const prompt = buildReclassifyPrompt(characterName, batch);

        let assignments: RoomAssignment[] = [];
        try {
            const result = await simpleLLMCall(
                apiConfig,
                [{ role: "user", content: prompt }],
                { temperature: 0.2, label: `记忆归档·${characterName}`, allowReasoningFallback: false },
            );
            assignments = result.content ? parseAssignments(result.content) : [];
        } catch (err) {
            console.warn("[MemoryReclassify] batch failed:", err);
            assignments = [];
        }

        const roomById = new Map<string, MemoryRoom>();
        for (const item of assignments) {
            if (item.room) roomById.set(item.id, item.room);
        }

        const patches: Array<{ id: string; room: MemoryRoom }> = [];
        for (const entry of batch) {
            const room = roomById.get(entry.id);
            if (!room) {
                skipped += 1;
                continue;
            }
            if (entry.room === room) {
                skipped += 1;
                continue;
            }
            patches.push({ id: entry.id, room });
        }

        if (patches.length > 0) {
            updated += await patchMemoryEntries(patches);
        }

        processed += batch.length;
        options?.onProgress?.({ processed, total: candidates.length, updated, skipped });
    }

    return { success: true, updated, skipped, total: candidates.length };
}
