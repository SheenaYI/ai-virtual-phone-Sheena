// lib/memory-storage.ts
// IndexedDB persistence for long-term memory entries + short-term events + localStorage config.

import type { MemoryEntry, MemoryConfig, MemoryRoom } from "./memory-types";
import {
    DEFAULT_CORE_MEMORY_PROMPT,
    DEFAULT_CORE_MEMORY_PROMPT_PLAIN,
    DEFAULT_MEMORY_CONFIG,
    DEFAULT_SUMMARIZATION_PROMPT,
    DEFAULT_SUMMARIZATION_PROMPT_PLAIN,
} from "./memory-types";
import {
    MEMORY_ROOMS,
    normalizeMemoryRoom,
    normalizeMemoryTags,
    normalizeRoomBudgets,
    normalizeRoomFlags,
    normalizeRoomList,
    normalizeRoomPrompts,
} from "./memory-room";
import { kvGet, kvSet, registerKvMigration, registerDynamicPrefix } from "./kv-db";
import { openIndexedDbAtLeast } from "./idb-open";

// ── Long-term memory DB (unchanged from v1) ──

const DB_NAME = "ai_phone_memory_db_v1";
// v4: 新增 by_character_room 索引（记忆宫殿）。
// 注意：索引只在 onupgradeneeded 里创建，不升版本号新索引不会生效。
// 升级不写数据迁移逻辑——旧条目 room 留空，由「重新归档房间」按需补齐
// （几千条一次性迁移会把 iOS Safari 内存顶爆）。
const DB_VERSION = 4;
const STORE_NAME = "memories";

const CONFIG_KEY = "ai_phone_memory_config_v1";

function hasBrowserApi(): boolean {
    return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function ensureMemoryIndexes(store: IDBObjectStore): void {
    if (!store.indexNames.contains("by_character")) {
        store.createIndex("by_character", "characterId", { unique: false });
    }
    if (!store.indexNames.contains("by_character_type")) {
        store.createIndex("by_character_type", ["characterId", "type"], { unique: false });
    }
    if (!store.indexNames.contains("by_character_created")) {
        store.createIndex("by_character_created", ["characterId", "createdAt"], { unique: false });
    }
    // 记忆宫殿：按角色 + 房间查询。旧条目的 room 为 undefined，
    // IndexedDB 不会把 undefined 编入索引，因此「未归档」需要走内存过滤（见 loadMemoryEntriesByRoom）。
    if (!store.indexNames.contains("by_character_room")) {
        store.createIndex("by_character_room", ["characterId", "room"], { unique: false });
    }
}

async function openDb(): Promise<IDBDatabase | null> {
    if (!hasBrowserApi()) return null;
    // Open at >= DB_VERSION: a backup restore may have bumped the stored version
    // higher, and opening at a fixed lower version would throw a VersionError.
    return openIndexedDbAtLeast(DB_NAME, DB_VERSION, (db, _oldVersion, tx) => {
        let store: IDBObjectStore;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        } else {
            store = tx!.objectStore(STORE_NAME);
        }
        ensureMemoryIndexes(store);
    }).catch(() => null);
}

function runRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ── Long-term Entry CRUD ──

export async function saveMemoryEntry(entry: MemoryEntry): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(entry);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function loadMemoryEntries(characterId: string): Promise<MemoryEntry[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        let entries: MemoryEntry[];
        try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const idx = store.index("by_character");
            entries = await runRequest(idx.getAll(characterId));
        } catch {
            const tx = db.transaction(STORE_NAME, "readonly");
            const allEntries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
            entries = allEntries.filter(entry => entry.characterId === characterId);
        }
        entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return entries;
    } finally {
        db.close();
    }
}

export async function loadMemoryEntriesByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<MemoryEntry[]> {
    const entries = await loadMemoryEntries(characterId);
    return entries.filter(entry => entry.type === type);
}

// ── 记忆宫殿：房间读写（只改字段，不动正文）──

/** 按房间筛选；room 省略 = 「未归档」（room 为空的历史数据）。 */
export function filterMemoryEntriesByRoom(entries: MemoryEntry[], room?: MemoryRoom): MemoryEntry[] {
    if (!room) return entries.filter(entry => !entry.room);
    return entries.filter(entry => entry.room === room);
}

export async function loadMemoryEntriesByRoom(
    characterId: string,
    room?: MemoryRoom,
): Promise<MemoryEntry[]> {
    const entries = await loadMemoryEntries(characterId);
    return filterMemoryEntriesByRoom(entries, room);
}

/** 统计各房间条数（含未归档，key 为 "" ) */
export async function countMemoryEntriesByRoom(
    characterId: string,
): Promise<Record<string, number>> {
    const entries = await loadMemoryEntriesByType(characterId, "long_term");
    const counts: Record<string, number> = {};
    for (const entry of entries) {
        const key = entry.room ?? "";
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}

export async function getMemoryEntryById(id: string): Promise<MemoryEntry | null> {
    const db = await openDb();
    if (!db) return null;
    try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const result = await runRequest(tx.objectStore(STORE_NAME).get(id));
        return (result as MemoryEntry | undefined) ?? null;
    } finally {
        db.close();
    }
}

export type MemoryEntryPatch = {
    /** null = 清空（回到未归档） */
    room?: MemoryRoom | null;
    pinned?: boolean;
    /** 空数组/null = 清空标签 */
    tags?: string[] | null;
};

/** 局部更新一条记忆的房间/置顶。正文、embedding、metadata 原样保留。 */
export async function patchMemoryEntry(id: string, patch: MemoryEntryPatch): Promise<MemoryEntry | null> {
    const existing = await getMemoryEntryById(id);
    if (!existing) return null;
    const next: MemoryEntry = { ...existing, updatedAt: new Date().toISOString() };
    if ("room" in patch) {
        const room = normalizeMemoryRoom(patch.room ?? undefined);
        if (room) next.room = room;
        else delete next.room;
    }
    if ("pinned" in patch) {
        if (patch.pinned) next.pinned = true;
        else delete next.pinned;
    }
    if ("tags" in patch) {
        const tags = normalizeMemoryTags(patch.tags ?? []);
        if (tags.length > 0) next.tags = tags;
        else delete next.tags;
    }
    await saveMemoryEntry(next);
    return next;
}

/** 批量写回房间（重新归档用）。只改字段，不重写正文——可安全重跑。 */
export async function patchMemoryEntries(
    patches: Array<{ id: string } & MemoryEntryPatch>,
): Promise<number> {
    let updated = 0;
    for (const patch of patches) {
        const { id, ...rest } = patch;
        const result = await patchMemoryEntry(id, rest);
        if (result) updated += 1;
    }
    return updated;
}

export async function deleteMemoryEntry(id: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(id);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function deleteMemoryEntries(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const id of ids) {
            store.delete(id);
        }
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function deleteCharacterMemories(characterId: string): Promise<void> {
    const entries = await loadMemoryEntries(characterId);
    await deleteMemoryEntries(entries.map(e => e.id));
}

export async function deleteCharacterMemoriesByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<void> {
    const entries = await loadMemoryEntriesByType(characterId, type);
    await deleteMemoryEntries(entries.map(e => e.id));
}

export async function getAllCharacterIdsWithMemories(): Promise<string[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const entries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
        const ids = new Set<string>();
        for (const e of entries) ids.add(e.characterId);
        return Array.from(ids);
    } finally {
        db.close();
    }
}

export async function getMemoryCount(characterId: string): Promise<number> {
    const entries = await loadMemoryEntries(characterId);
    return entries.length;
}

export async function getMemoryCountByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<number> {
    const entries = await loadMemoryEntriesByType(characterId, type);
    return entries.length;
}

// ── Config (localStorage for fast sync access) ──

/** 补齐/纠正房间相关字段，旧配置（没有这些字段）也能安全读取。 */
export function normalizeMemoryConfig(config: MemoryConfig): MemoryConfig {
    return {
        ...config,
        roomEnabled: config.roomEnabled === true,
        roomPrompts: normalizeRoomPrompts(config.roomPrompts),
        roomPromptRooms: normalizeRoomList(config.roomPromptRooms, MEMORY_ROOMS),
        roomBudgets: normalizeRoomBudgets(config.roomBudgets),
        roomResident: normalizeRoomFlags(config.roomResident),
        roomTruncationMode: config.roomTruncationMode === "perRoom" ? "perRoom" : "global",
        coreMemoryRoomFilterEnabled: config.coreMemoryRoomFilterEnabled === true,
        coreMemoryRooms: normalizeRoomList(config.coreMemoryRooms, MEMORY_ROOMS),
        reclassifySkipManual: config.reclassifySkipManual !== false,
    };
}

export function loadMemoryConfig(): MemoryConfig {
    if (typeof window === "undefined") return normalizeMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    try {
        const raw = kvGet(CONFIG_KEY);
        if (!raw) return normalizeMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
        return normalizeMemoryConfig({ ...DEFAULT_MEMORY_CONFIG, ...JSON.parse(raw) });
    } catch {
        return normalizeMemoryConfig({ ...DEFAULT_MEMORY_CONFIG });
    }
}

export function saveMemoryConfig(config: MemoryConfig): void {
    if (typeof window === "undefined") return;
    kvSet(CONFIG_KEY, JSON.stringify(config));
}

// ── 模板迁移（房间版提示词）──

function isFactoryPlainLongTermPrompt(text: string | undefined): boolean {
    const value = (text ?? "").trim();
    return value === "" || value === DEFAULT_SUMMARIZATION_PROMPT_PLAIN.trim();
}

function isFactoryPlainCorePrompt(text: string | undefined): boolean {
    const value = (text ?? "").trim();
    return value === "" || value === DEFAULT_CORE_MEMORY_PROMPT_PLAIN.trim();
}

/**
 * 套用房间版提示词模板。
 *
 * 默认行为（force = false）：**只在模板仍是出厂原文时替换**。
 * 用户手改过的正文绝不覆盖——改写别人的提示词是很恼人的事。
 * force = true（UI 上点「应用房间模板」）才强制覆盖。
 *
 * 注：房间规则通过 {{roomSpec}} / {{rooms}} 在总结时运行时注入，
 * 所以之后改房间提示词、勾选房间都不需要再次改写模板。
 */
export function applyRoomPromptTemplate(
    config: MemoryConfig,
    options?: { force?: boolean },
): { config: MemoryConfig; replacedLongTerm: boolean; replacedCore: boolean } {
    const force = options?.force === true;
    const next: MemoryConfig = { ...config };

    const replacedLongTerm = force || isFactoryPlainLongTermPrompt(config.summarizationPrompt);
    if (replacedLongTerm) next.summarizationPrompt = DEFAULT_SUMMARIZATION_PROMPT;

    const replacedCore = force || isFactoryPlainCorePrompt(config.coreMemoryPrompt);
    if (replacedCore) next.coreMemoryPrompt = DEFAULT_CORE_MEMORY_PROMPT;

    return { config: next, replacedLongTerm, replacedCore };
}

/** 提示词里是否已包含房间占位符（没有的话总结时会自动追加房间规则）。 */
export function hasRoomSpecPlaceholder(text: string | undefined): boolean {
    return /\{\{\s*roomSpec\s*\}\}/i.test(text ?? "");
}

export function hasRoomsPlaceholder(text: string | undefined): boolean {
    return /\{\{\s*rooms\s*\}\}/i.test(text ?? "");
}

// ── Per-character event counter (localStorage) ──

const EVENT_COUNTER_PREFIX = "ai_phone_mem_evt_count_";
const LAST_SUMMARY_TS_PREFIX = "ai_phone_mem_last_sum_";
const CORE_COUNTER_PREFIX = "ai_phone_mem_core_count_";
const LAST_CORE_SUMMARY_TS_PREFIX = "ai_phone_mem_last_core_sum_";
registerKvMigration(CONFIG_KEY);
registerDynamicPrefix(EVENT_COUNTER_PREFIX);
registerDynamicPrefix(LAST_SUMMARY_TS_PREFIX);
registerDynamicPrefix(CORE_COUNTER_PREFIX);
registerDynamicPrefix(LAST_CORE_SUMMARY_TS_PREFIX);

export function getEventCounter(characterId: string): number {
    if (typeof window === "undefined") return 0;
    const val = kvGet(EVENT_COUNTER_PREFIX + characterId);
    return val ? parseInt(val, 10) || 0 : 0;
}

export function incrementEventCounter(characterId: string): number {
    const next = getEventCounter(characterId) + 1;
    if (typeof window !== "undefined") {
        kvSet(EVENT_COUNTER_PREFIX + characterId, String(next));
    }
    return next;
}

export function resetEventCounter(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(EVENT_COUNTER_PREFIX + characterId, "0");
}

export function getLastSummarizedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_SUMMARY_TS_PREFIX + characterId) || null;
}

export function setLastSummarizedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_SUMMARY_TS_PREFIX + characterId, ts);
}

export function getCoreMemoryCounter(characterId: string): number {
    if (typeof window === "undefined") return 0;
    const val = kvGet(CORE_COUNTER_PREFIX + characterId);
    return val ? parseInt(val, 10) || 0 : 0;
}

export function incrementCoreMemoryCounter(characterId: string): number {
    const next = getCoreMemoryCounter(characterId) + 1;
    if (typeof window !== "undefined") {
        kvSet(CORE_COUNTER_PREFIX + characterId, String(next));
    }
    return next;
}

export function resetCoreMemoryCounter(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(CORE_COUNTER_PREFIX + characterId, "0");
}

export function getLastCoreSummarizedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_CORE_SUMMARY_TS_PREFIX + characterId) || null;
}

export function setLastCoreSummarizedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_CORE_SUMMARY_TS_PREFIX + characterId, ts);
}
