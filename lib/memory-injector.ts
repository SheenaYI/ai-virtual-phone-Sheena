// lib/memory-injector.ts
// Formats memory entries into injectable prompt text.

import type { MemoryEntry, MemoryRoom } from "./memory-types";
import { MEMORY_ROOM_META, MEMORY_ROOMS } from "./memory-room";

/**
 * Format long-term memories for prompt injection.
 *
 * 记忆宫殿（options.groupByRoom = true）时按房间分组输出：
 *   <room name="客厅">
 *   - 记忆内容
 *   </room>
 *
 * 退化成旧格式的条件：开关关闭，或所有条目都没有房间。
 * 这样未开启记忆宫殿时，注入文本与旧版一字不差。
 */
export function formatLongTermMemories(
    memories: MemoryEntry[],
    options?: { groupByRoom?: boolean },
): string {
    if (memories.length === 0) return "";

    const grouped = options?.groupByRoom === true && memories.some(entry => Boolean(entry.room));
    if (!grouped) {
        const lines: string[] = [];
        for (const entry of memories) {
            lines.push(`- ${entry.content}`);
        }
        return lines.join("\n");
    }

    const blocks: string[] = [];
    for (const room of MEMORY_ROOMS) {
        const items = memories.filter(entry => entry.room === room);
        if (items.length === 0) continue;
        blocks.push(formatRoomBlock(room, items));
    }

    const unfiled = memories.filter(entry => !entry.room);
    if (unfiled.length > 0) {
        blocks.push(formatPlainBlock("未归档", unfiled));
    }

    return blocks.join("\n");
}

function formatRoomBlock(room: MemoryRoom, items: MemoryEntry[]): string {
    return formatPlainBlock(MEMORY_ROOM_META[room]?.label ?? room, items);
}

function formatPlainBlock(label: string, items: MemoryEntry[]): string {
    const lines = items.map(entry => `- ${entry.content}`);
    return [`<room name="${label}">`, ...lines, "</room>"].join("\n");
}

export function formatCoreMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";

    const lines: string[] = [];
    for (const entry of memories) {
        lines.push(`- ${entry.content}`);
    }
    return lines.join("\n");
}
