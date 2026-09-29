"use client";

import { Component, useState, useEffect, useCallback, type CSSProperties, type ReactNode } from "react";
import { Trash2, Zap, Clock, Users, Archive, AlertCircle, Search, Brain, FileText, MoreHorizontal, Plus, Edit3, X, Check, ChevronRight, Filter, Home, Pin, Wand2, FolderOpen, type LucideIcon } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/modal";
import { MemoryTimeline } from "./memory-timeline";
import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import type { MemoryEntry, MemoryConfig, MemoryRoom } from "@/lib/memory-types";
import {
    DEFAULT_CORE_MEMORY_PROMPT,
    DEFAULT_SUMMARIZATION_PROMPT,
    MEMORY_CORE_PROMPT_PLACEHOLDERS,
    MEMORY_LONG_TERM_PROMPT_PLACEHOLDERS,
} from "@/lib/memory-types";
import {
    loadMemoryConfig,
    saveMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntry,
    deleteCharacterMemoriesByType,
    getAllCharacterIdsWithMemories,
    getMemoryCountByType,
    getLastSummarizedTimestamp,
    getLastCoreSummarizedTimestamp,
    patchMemoryEntry,
    applyRoomPromptTemplate,
    hasRoomSpecPlaceholder,
} from "@/lib/memory-storage";
import {
    MEMORY_ROOMS,
    MEMORY_ROOM_META,
    UNFILED_ROOM_LABEL,
    ROOM_BUDGET_MAX,
    ROOM_BUDGET_MIN,
    ROOM_BUDGET_STEP,
} from "@/lib/memory-room";
import { reclassifyMemoryRooms } from "@/lib/memory-room-reclassify";
import { estimateTokens } from "@/lib/token-counter";
import { hydrateChatStorage } from "@/lib/chat-storage";
import { loadNativeTimeline, type NativeTimelineEntry } from "@/lib/short-term-assembler";
import { runSummarizationPipeline } from "@/lib/memory-summarizer";
import { runCoreMemoryPipeline } from "@/lib/core-memory-builder";
import { resolveAuxiliaryApiConfig, resolveUserIdentity } from "@/lib/settings-storage";
import { generateEmbedding, resolveEmbeddingModel } from "@/lib/memory-embedding";
import { BINDING_ACCENTS } from "@/lib/ui-accent-colors";

type MemoryView = "list" | "detail" | "settings";
type MemoryTab = "short" | "shared" | "core" | "long";
type MemoryBudgetKey = "shortTermTokenBudget" | "coreMemoryTokenBudget" | "longTermTokenBudget";

const MEMORY_TOKEN_BUDGET_MAX = 100000;
const MEMORY_TOKEN_BUDGET_MIN: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 1000,
    coreMemoryTokenBudget: 100,
    longTermTokenBudget: 200,
};
const MEMORY_TOKEN_BUDGET_STEP: Record<MemoryBudgetKey, number> = {
    shortTermTokenBudget: 5000,
    coreMemoryTokenBudget: 1000,
    longTermTokenBudget: 1000,
};
const MANUAL_MEMORY_CONTENT_LIMIT = 3000;
// 详情页时间线最多解析渲染的条数：全量历史可能有几万条，
// 一次性解析+渲染会把 iOS Safari 的单页内存顶爆（灰屏杀页）
const MEMORY_TIMELINE_ENTRY_CAP = 2000;

/** 详情页兜底：时间线渲染抛错时显示提示，而不是整页白屏 */
class MemoryDetailBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() {
        if (this.state.failed) {
            return <p className="text-center ts-14 mt-10 text-secondary">这一页加载出错了，返回上一页再试一次。</p>;
        }
        return this.props.children;
    }
}

type SummarizeRange = "auto" | "all" | number;

const SUMMARIZE_RANGE_OPTIONS: Array<{ value: SummarizeRange; label: string; desc?: string }> = [
    { value: "auto", label: "接着上次总结", desc: "默认方式，从上次进度继续" },
    { value: 1, label: "最近 1 天" },
    { value: 3, label: "最近 3 天" },
    { value: 7, label: "最近 7 天" },
    { value: 14, label: "最近 14 天" },
    { value: 30, label: "最近 30 天" },
    { value: "all", label: "全部历史" },
];

type MemorySourceKey = keyof NonNullable<MemoryConfig["shortTermAllowedSources"]>;

/** 记忆来源开关：同时作用于短期上下文与长期总结 */
const MEMORY_SOURCE_OPTIONS: Array<{ key: MemorySourceKey; label: string }> = [
    { key: "chat", label: "私聊上下文" },
    { key: "group_chat", label: "群聊上下文" },
    { key: "moments", label: "朋友圈" },
    { key: "checkphone", label: "查手机" },
    { key: "diary", label: "手记便签" },
    { key: "xiaohongshu", label: "小红书" },
    { key: "interview_magazine", label: "在场访谈" },
    { key: "cocreate", label: "共创" },
    { key: "game", label: "内置小游戏" },
    { key: "story", label: "剧情小剧场" },
    { key: "vn", label: "漫卷" },
    { key: "adventure", label: "地图冒险" },
    { key: "custom_app", label: "自定义应用" },
];

type MemoryEditorState = {
    type: MemoryEntry["type"];
    entry?: MemoryEntry;
    content: string;
    /** 记忆宫殿房间（可选）；新增时可由所在房间卡片预选 */
    room?: MemoryRoom;
};

/** 房间 chip 的筛选值：all = 全部，none = 未归档 */
type RoomFilter = "all" | "none" | MemoryRoom;

const memorySettingsIconStyle = (color: string): CSSProperties => ({
    "--icon-color": color,
} as CSSProperties);

function MemorySettingsIcon({ icon: Icon, color }: { icon: LucideIcon; color: string }) {
    return (
        <span className="card-icon" style={memorySettingsIconStyle(color)}>
            <Icon size={22} strokeWidth={1.75} />
        </span>
    );
}

function MemorySettingsSliderItem({
    icon,
    color,
    label,
    desc,
    value,
    min,
    max,
    step,
    onChange,
}: {
    icon: LucideIcon;
    color: string;
    label: string;
    desc: string;
    value: number;
    min: number;
    max: number;
    step: number;
    onChange: (value: number) => void;
}) {
    return (
        <div className="menu-item memory-slider-item">
            <div className="memory-slider-header">
                <MemorySettingsIcon icon={icon} color={color} />
                <div className="menu-label-group">
                    <span className="menu-label">{label}</span>
                    <span className="menu-desc">{desc}</span>
                </div>
                <span className="ui-slider-value memory-slider-current">{value}</span>
            </div>
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                onChange={e => onChange(Number(e.target.value))}
                className="ui-slider memory-settings-slider"
                aria-label={label}
            />
        </div>
    );
}

function relativeTime(isoStr: string): string {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "刚刚";
    if (mins < 60) return `${mins}分钟前`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}天前`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}周前`;
    return `${Math.floor(days / 30)}个月前`;
}

type CharacterMemoryInfo = {
    character: Character;
    longTermCount: number;
    coreCount: number;
    shortTermCount: number;
};

type Props = {
    view: MemoryView;
    selectedCharId?: string;
    onSelectChar: (charId: string) => void;
    onNotice?: (msg: string) => void;
};

export function MemoryBankPage({ view, selectedCharId, onSelectChar, onNotice }: Props) {
    const [config, setConfig] = useState<MemoryConfig>(loadMemoryConfig);
    const [characters, setCharacters] = useState<CharacterMemoryInfo[]>([]);
    const [activeTab, setActiveTab] = useState<MemoryTab>("short");
    const [coreEntries, setCoreEntries] = useState<MemoryEntry[]>([]);
    const [longTermEntries, setLongTermEntries] = useState<MemoryEntry[]>([]);
    const [shortTermEvents, setShortTermEvents] = useState<NativeTimelineEntry[]>([]);
    const [sharedEvents, setSharedEvents] = useState<NativeTimelineEntry[]>([]);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [summarizing, setSummarizing] = useState(false);
    const [rebuildingCore, setRebuildingCore] = useState(false);
    const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
    const [editingCorePrompt, setEditingCorePrompt] = useState<string | null>(null);
    const [confirmDeleteEntryId, setConfirmDeleteEntryId] = useState<string | null>(null);
    const [confirmClearAll, setConfirmClearAll] = useState(false);
    const [pickedCharId, setPickedCharId] = useState<string | null>(null);
    const [entryMenuId, setEntryMenuId] = useState<string | null>(null);
    const [memoryEditor, setMemoryEditor] = useState<MemoryEditorState | null>(null);
    const [savingMemory, setSavingMemory] = useState(false);
    const [summarizeRangeOpen, setSummarizeRangeOpen] = useState(false);
    const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
    // ── 记忆宫殿 ──
    const [roomFilter, setRoomFilter] = useState<RoomFilter>("all");
    const [reclassifying, setReclassifying] = useState(false);
    const [reclassifyProgress, setReclassifyProgress] = useState<string | null>(null);
    const [roomPromptEditing, setRoomPromptEditing] = useState<Partial<Record<MemoryRoom, string>>>({});
    const [reclassifyScopeOpen, setReclassifyScopeOpen] = useState(false);
    const [roomPromptPickerOpen, setRoomPromptPickerOpen] = useState(false);
    const [activeRoomPrompt, setActiveRoomPrompt] = useState<MemoryRoom>("living");

    const disabledSourceCount = MEMORY_SOURCE_OPTIONS
        .filter(source => (config.shortTermAllowedSources ?? {})[source.key] === false).length;

    // Resolve selected character object from ID
    const selectedChar = selectedCharId
        ? loadCharacters().find(c => c.id === selectedCharId) ?? null
        : null;

    const loadCharacterList = useCallback(async (isCancelled?: () => boolean) => {
        const allChars = loadCharacters();

        let charIdsWithMem: string[] = [];
        try { charIdsWithMem = await getAllCharacterIdsWithMemories(); } catch { /* DB may fail */ }

        const infos: CharacterMemoryInfo[] = [];
        const seen = new Set<string>();

        // Characters with memories first
        for (const id of charIdsWithMem) {
            const char = allChars.find(c => c.id === id);
            if (!char) continue;
            seen.add(id);
            let ltCount = 0;
            let coreCount = 0;
            try {
                [ltCount, coreCount] = await Promise.all([
                    getMemoryCountByType(id, "long_term"),
                    getMemoryCountByType(id, "core"),
                ]);
            } catch { /* ignore */ }
            infos.push({ character: char, longTermCount: ltCount, coreCount, shortTermCount: 0 });
        }

        // Remaining characters
        for (const char of allChars) {
            if (seen.has(char.id)) continue;
            infos.push({ character: char, longTermCount: 0, coreCount: 0, shortTermCount: 0 });
        }

        if (isCancelled?.()) return;
        setCharacters(infos);

        // 短期计数逐个异步补齐：loadNativeTimeline 是全量组装，重数据账号
        // 在循环里同步跑完会长时间卡死主线程、瞬时吃掉大量内存
        for (const info of infos) {
            await new Promise(resolve => setTimeout(resolve, 0));
            if (isCancelled?.()) return;
            let stCount = 0;
            try { stCount = loadNativeTimeline(info.character.id).length; } catch { /* ignore */ }
            if (isCancelled?.()) return;
            setCharacters(prev => prev.map(item =>
                item.character.id === info.character.id ? { ...item, shortTermCount: stCount } : item));
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        void loadCharacterList(() => cancelled);
        return () => { cancelled = true; };
    }, [loadCharacterList]);

    // Load detail data when entering detail view
    const loadDetailData = useCallback(async (charId: string) => {
        setLoading(true);
        try {
            await hydrateChatStorage();
            const [core, lt] = await Promise.all([
                loadMemoryEntriesByType(charId, "core"),
                loadMemoryEntriesByType(charId, "long_term"),
            ]);
            setCoreEntries(core);
            setLongTermEntries(lt);
        } catch {
            setCoreEntries([]);
            setLongTermEntries([]);
        }
        // Native timeline is sync (localStorage) — no await needed.
        // 只取最近一段（全量可能几万条），防止解析+渲染把 iOS Safari 内存顶爆
        const timeline = loadNativeTimeline(charId).slice(-MEMORY_TIMELINE_ENTRY_CAP);
        setShortTermEvents(timeline.filter(e =>
            !(e.sourceApp === "moments" && e.postAuthorType === "user")
            && !(e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setSharedEvents(timeline.filter(e =>
            (e.sourceApp === "moments" && e.postAuthorType === "user") ||
            (e.sourceApp === "chat" && e.sourceDetail === "group") ||
            (e.sourceApp === "interview_magazine" && e.sourceDetail === "interview_shared_issue")
        ));
        setLoading(false);
    }, []);

    // Reload detail data when view changes to detail
    useEffect(() => {
        if (view === "detail" && selectedCharId) {
            setActiveTab("short");
            setExpandedId(null);
            loadDetailData(selectedCharId);
        }
    }, [view, selectedCharId, loadDetailData]);

    // Reset editing prompt when leaving settings
    useEffect(() => {
        if (view !== "settings") {
            setEditingPrompt(null);
            setEditingCorePrompt(null);
        }
    }, [view]);

    const handleSelectChar = (char: Character) => {
        onSelectChar(char.id);
    };

    const handleDeleteEntry = async (id: string) => {
        await deleteMemoryEntry(id);
        setCoreEntries(prev => prev.filter(e => e.id !== id));
        setLongTermEntries(prev => prev.filter(e => e.id !== id));
        setEntryMenuId(null);
        loadCharacterList();
    };

    const showNotice = (msg: string) => {
        onNotice?.(msg);
    };

    // ── 记忆宫殿：房间 / 置顶 ──
    const handleSetRoom = async (id: string, room: MemoryRoom | null) => {
        const updated = await patchMemoryEntry(id, { room });
        if (updated) {
            setLongTermEntries(prev => prev.map(entry => entry.id === id ? updated : entry));
            showNotice(room ? `已移入「${MEMORY_ROOM_META[room].label}」` : "已移出房间（未归档）");
        }
        setEntryMenuId(null);
    };

    const handleTogglePin = async (entry: MemoryEntry) => {
        const updated = await patchMemoryEntry(entry.id, { pinned: !entry.pinned });
        if (updated) {
            setLongTermEntries(prev => prev.map(item => item.id === entry.id ? updated : item));
            showNotice(updated.pinned ? "已置顶，不参与截断与淘汰" : "已取消置顶");
        }
        setEntryMenuId(null);
    };

    const handleReclassify = async (scope: "unassigned" | "all") => {
        if (!selectedCharId || reclassifying) return;
        setReclassifying(true);
        setReclassifyProgress("准备中...");
        try {
            const result = await reclassifyMemoryRooms(
                selectedCharId,
                selectedChar?.name ?? "",
                config,
                {
                    scope,
                    includeManual: !config.reclassifySkipManual,
                    onProgress: progress => setReclassifyProgress(
                        `已处理 ${progress.processed}/${progress.total}（归档 ${progress.updated}）`,
                    ),
                },
            );
            if (!result.success) {
                showNotice(result.error || "重新归档失败");
            } else {
                showNotice(`重新归档完成：归档 ${result.updated} 条，跳过 ${result.skipped} 条`);
                await loadDetailData(selectedCharId);
                loadCharacterList();
            }
        } catch (err) {
            console.error("[MemoryBank] Reclassify failed:", err);
            showNotice("重新归档失败: " + String(err));
        } finally {
            setReclassifying(false);
            setReclassifyProgress(null);
        }
    };

    const saveRoomBudget = (room: MemoryRoom, value: number) => {
        if (!Number.isFinite(value)) return;
        const clamped = Math.min(ROOM_BUDGET_MAX, Math.max(ROOM_BUDGET_MIN, Math.round(value)));
        const next = { ...config, roomBudgets: { ...config.roomBudgets, [room]: clamped } };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const toggleRoomEnabledForPrompt = (room: MemoryRoom) => {
        const current = config.roomPromptRooms ?? [];
        const has = current.includes(room);
        const nextRooms = has ? current.filter(item => item !== room) : [...current, room];
        // 至少保留一个房间，否则总结时没有任何房间可选
        if (nextRooms.length === 0) {
            showNotice("至少要保留一个房间");
            return;
        }
        const next = { ...config, roomPromptRooms: nextRooms };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const toggleCoreMemoryRoom = (room: MemoryRoom) => {
        const current = config.coreMemoryRooms ?? [];
        const has = current.includes(room);
        const nextRooms = has ? current.filter(item => item !== room) : [...current, room];
        if (nextRooms.length === 0) {
            showNotice("至少要保留一个房间");
            return;
        }
        const next = { ...config, coreMemoryRooms: nextRooms };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveRoomPrompt = (room: MemoryRoom) => {
        const text = roomPromptEditing[room];
        if (text === undefined) return;
        const next = { ...config, roomPrompts: { ...config.roomPrompts, [room]: text.trim() || MEMORY_ROOM_META[room].criteria } };
        setConfig(next);
        saveMemoryConfig(next);
        setRoomPromptEditing(prev => {
            const copy = { ...prev };
            delete copy[room];
            return copy;
        });
        showNotice(`「${MEMORY_ROOM_META[room].label}」的归档标准已保存`);
    };

    const handleApplyRoomTemplate = (force: boolean) => {
        const result = applyRoomPromptTemplate(config, { force });
        if (!result.replacedLongTerm && !result.replacedCore) {
            showNotice("当前提示词不是出厂原文，已跳过；如需覆盖请再次确认强制套用");
            return;
        }
        setConfig(result.config);
        saveMemoryConfig(result.config);
        setEditingPrompt(null);
        setEditingCorePrompt(null);
        showNotice(force ? "已套用房间版提示词模板" : "已套用房间版提示词模板（仅替换出厂原文）");
    };

    const handleClearEntries = async (type: "core" | "long_term") => {
        if (!selectedCharId) return;
        await deleteCharacterMemoriesByType(selectedCharId, type);
        if (type === "core") setCoreEntries([]);
        else setLongTermEntries([]);
        loadCharacterList();
    };

    const handleManualSummarize = async (range: SummarizeRange = "auto") => {
        if (!selectedCharId || summarizing) return;
        setSummarizeRangeOpen(false);
        setSummarizing(true);
        try {
            const sinceTimestamp = typeof range === "number"
                ? new Date(Date.now() - range * 86400000).toISOString()
                : undefined;
            const afterTimestamp = range === "all"
                ? undefined
                : sinceTimestamp ?? getLastSummarizedTimestamp(selectedCharId) ?? undefined;
            const timelineCount = loadNativeTimeline(
                selectedCharId,
                afterTimestamp ? { afterTimestamp } : undefined,
            ).length;
            if (timelineCount < 4) {
                showNotice("所选范围内事件不足 4 条");
                return;
            }

            const result = await runSummarizationPipeline(
                selectedCharId,
                selectedChar?.name ?? "",
                range === "all" ? { force: true } : sinceTimestamp ? { sinceTimestamp } : undefined,
            );
            if (result.success) {
                showNotice("总结完成");
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "总结失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual summarize failed:", err);
            showNotice("总结失败: " + String(err));
        } finally {
            setSummarizing(false);
        }
    };

    const handleManualRebuildCore = async () => {
        if (!selectedCharId || rebuildingCore) return;
        setRebuildingCore(true);
        try {
            const lastCoreSummarizedAt = getLastCoreSummarizedTimestamp(selectedCharId);
            const longTermEntries = await loadMemoryEntriesByType(selectedCharId, "long_term");
            const pendingLongTermCount = longTermEntries.filter(entry =>
                !lastCoreSummarizedAt || entry.createdAt > lastCoreSummarizedAt
            ).length;
            if (pendingLongTermCount === 0) {
                showNotice(lastCoreSummarizedAt ? "没有新的长期记忆需要总结" : "没有可用于总结核心记忆的长期记忆");
                return;
            }

            const result = await runCoreMemoryPipeline(selectedCharId, selectedChar?.name ?? "");
            if (result.success) {
                showNotice(result.rebuiltCount ? `核心记忆已重建（${result.rebuiltCount}条）` : "核心记忆已重建");
                loadDetailData(selectedCharId);
                loadCharacterList();
            } else {
                showNotice(result.error || "核心记忆重建失败");
            }
        } catch (err) {
            console.error("[MemoryBank] Manual core rebuild failed:", err);
            showNotice("核心记忆重建失败: " + String(err));
        } finally {
            setRebuildingCore(false);
        }
    };

    const saveBudget = (key: MemoryBudgetKey, value: number) => {
        if (!Number.isFinite(value)) return;
        const min = MEMORY_TOKEN_BUDGET_MIN[key];
        const nextValue = Math.min(MEMORY_TOKEN_BUDGET_MAX, Math.max(min, Math.round(value)));
        const next = { ...config, [key]: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(200, Math.max(10, Math.round(value)));
        const next = { ...config, summarizationEventInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    const saveCoreInterval = (value: number) => {
        if (!Number.isFinite(value)) return;
        const nextValue = Math.min(20, Math.max(1, Math.round(value)));
        const next = { ...config, coreSummarizationInterval: nextValue };
        setConfig(next);
        saveMemoryConfig(next);
    };

    // ── Prompt editing ──
    const handleSavePrompt = () => {
        if (editingPrompt === null) return;
        const next = { ...config, summarizationPrompt: editingPrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("提示词已保存");
    };

    const handleResetPrompt = () => {
        setEditingPrompt(DEFAULT_SUMMARIZATION_PROMPT);
        const next = { ...config, summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("已恢复默认提示词");
    };

    const handleSaveCorePrompt = () => {
        if (editingCorePrompt === null) return;
        const next = { ...config, coreMemoryPrompt: editingCorePrompt };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("核心记忆提示词已保存");
    };

    const handleResetCorePrompt = () => {
        setEditingCorePrompt(DEFAULT_CORE_MEMORY_PROMPT);
        const next = { ...config, coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT };
        setConfig(next);
        saveMemoryConfig(next);
        showNotice("核心记忆提示词已恢复默认");
    };

    const createManualMemoryId = (type: MemoryEntry["type"]) => (
        `mem_${type === "core" ? "core" : "lt"}_manual_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    );

    const isManualMemoryEntry = (entry: MemoryEntry) => {
        const origin = String(entry.metadata?.origin ?? "");
        return origin === "user_manual" || origin === "user_edited" || entry.id.includes("_manual_");
    };

    const maybeBuildManualMemoryEmbedding = async (type: MemoryEntry["type"], content: string): Promise<number[] | undefined> => {
        if (type !== "long_term" || !config.vectorRecallEnabled) return undefined;
        const embeddingApiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
        if (!embeddingApiConfig || !resolveEmbeddingModel(embeddingApiConfig)) return undefined;
        try {
            return await generateEmbedding(content, embeddingApiConfig) ?? undefined;
        } catch {
            return undefined;
        }
    };

    const openCreateMemoryEditor = (type: MemoryEntry["type"], room?: MemoryRoom) => {
        setEntryMenuId(null);
        // 在某个房间卡片下点「新增」时预选该房间
        setMemoryEditor({ type, content: "", ...(room ? { room } : {}) });
    };

    const openEditMemoryEditor = (entry: MemoryEntry) => {
        setEntryMenuId(null);
        setMemoryEditor({
            type: entry.type,
            entry,
            content: entry.content,
            ...(entry.room ? { room: entry.room } : {}),
        });
    };

    const handleSaveManualMemory = async () => {
        if (!selectedCharId || !memoryEditor || savingMemory) return;
        const content = memoryEditor.content.trim();
        if (!content) {
            showNotice("记忆内容不能为空");
            return;
        }
        if (content.length > MANUAL_MEMORY_CONTENT_LIMIT) {
            showNotice(`记忆内容过长，请控制在 ${MANUAL_MEMORY_CONTENT_LIMIT} 字以内`);
            return;
        }

        setSavingMemory(true);
        try {
            const now = new Date().toISOString();
            const type = memoryEditor.type;
            const source = memoryEditor.entry;
            const contentChanged = !source || source.content.trim() !== content;
            const embedding = type === "long_term"
                ? (contentChanged ? await maybeBuildManualMemoryEmbedding(type, content) : source?.embedding)
                : undefined;
            // 房间只作用于长期记忆（核心记忆是提炼结果，不参与房间划分）
            const editorRoom = type === "long_term" ? memoryEditor.room : undefined;
            const entry: MemoryEntry = source
                ? {
                    ...source,
                    content,
                    embedding,
                    updatedAt: now,
                    metadata: {
                        ...(source.metadata ?? {}),
                        origin: isManualMemoryEntry(source) ? "user_manual" : "user_edited",
                        editedByUser: true,
                    },
                }
                : {
                    id: createManualMemoryId(type),
                    characterId: selectedCharId,
                    sourceApp: "chat",
                    type,
                    content,
                    embedding,
                    importance: type === "core" ? 0.95 : 0.8,
                    createdAt: now,
                    updatedAt: now,
                    metadata: {
                        origin: "user_manual",
                    },
                };
            // 显式写入/清除房间，避免旧房间在编辑后残留
            if (editorRoom) entry.room = editorRoom;
            else delete entry.room;

            await saveMemoryEntry(entry);
            if (type === "core") {
                setCoreEntries(prev => source ? prev.map(item => item.id === entry.id ? entry : item) : [...prev, entry]);
            } else {
                setLongTermEntries(prev => source ? prev.map(item => item.id === entry.id ? entry : item) : [...prev, entry]);
            }
            setMemoryEditor(null);
            setExpandedId(entry.id);
            loadCharacterList();
            showNotice(type === "core" ? "核心记忆已保存" : "长期记忆已保存");
        } catch (error) {
            console.error("[MemoryBank] Save manual memory failed:", error);
            showNotice("记忆保存失败: " + String(error));
        } finally {
            setSavingMemory(false);
        }
    };

    const renderEntryCard = (entry: MemoryEntry) => (
        <div
            key={entry.id}
            className={`g-card memory-report-card${entryMenuId === entry.id ? " is-menu-open" : ""}${entry.pinned ? " is-pinned" : ""}`}
            onClick={() => {
                if (entryMenuId) {
                    setEntryMenuId(null);
                    return;
                }
                setExpandedId(expandedId === entry.id ? null : entry.id);
            }}
        >
            <div className="mem-report-head">
                <span className="ts-11 text-secondary" style={{ letterSpacing: "1px" }}>[ DATE: {relativeTime(entry.createdAt)} ]</span>
                <div className="mem-report-actions">
                    {entry.pinned ? (
                        <span className="mem-pin-badge" title="置顶：不参与截断与淘汰">
                            <Pin size={11} strokeWidth={2} />
                        </span>
                    ) : null}
                    <span className={`mem-origin-badge ${isManualMemoryEntry(entry) ? "is-manual" : ""}`}>
                        {isManualMemoryEntry(entry) ? "MANUAL" : "AUTO"}
                    </span>
                    <div className="mem-entry-menu-wrap">
                        <button
                            className="mem-entry-menu-btn"
                            onClick={(event) => {
                                event.stopPropagation();
                                setEntryMenuId(prev => prev === entry.id ? null : entry.id);
                            }}
                            title="更多"
                        >
                            <MoreHorizontal size={18} />
                        </button>
                        {entryMenuId === entry.id && (
                            <div className="mem-entry-menu" onClick={event => event.stopPropagation()}>
                                <button onClick={() => openEditMemoryEditor(entry)}>
                                    <Edit3 size={13} />
                                    <span>编辑</span>
                                </button>
                                <button onClick={() => handleTogglePin(entry)}>
                                    <Pin size={13} />
                                    <span>{entry.pinned ? "取消置顶" : "置顶"}</span>
                                </button>
                                {entry.type === "long_term" ? (
                                    <>
                                        <div className="mem-entry-menu-title">移入房间</div>
                                        <div className="mem-entry-menu-rooms">
                                            {MEMORY_ROOMS.map(room => (
                                                <button
                                                    key={room}
                                                    className={`mem-entry-menu-room${entry.room === room ? " is-active" : ""}`}
                                                    onClick={() => handleSetRoom(entry.id, room)}
                                                >
                                                    {MEMORY_ROOM_META[room].label}
                                                </button>
                                            ))}
                                            <button
                                                className={`mem-entry-menu-room${!entry.room ? " is-active" : ""}`}
                                                onClick={() => handleSetRoom(entry.id, null)}
                                            >
                                                {UNFILED_ROOM_LABEL}
                                            </button>
                                        </div>
                                    </>
                                ) : null}
                                <button
                                    className="is-danger"
                                    onClick={() => {
                                        setEntryMenuId(null);
                                        setConfirmDeleteEntryId(entry.id);
                                    }}
                                >
                                    <Trash2 size={13} />
                                    <span>删除</span>
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
            <div className="ts-12 leading-[1.7]">
                {expandedId === entry.id
                    ? entry.content
                    : entry.content.length > 100
                        ? entry.content.slice(0, 100) + "..."
                        : entry.content
                }
            </div>
        </div>
    );

    /** 记忆宫殿：长期记忆按房间分区展示（含未归档） */
    const renderRoomsGroupedEntries = (entries: MemoryEntry[]) => {
        const filtered = entries.filter(entry => {
            if (roomFilter === "all") return true;
            if (roomFilter === "none") return !entry.room;
            return entry.room === roomFilter;
        });
        if (filtered.length === 0) {
            return (
                <div className="mem-empty-card">
                    <p>这个分组下还没有记忆。</p>
                    <button
                        className="mem-empty-add-btn"
                        onClick={() => openCreateMemoryEditor("long_term", roomFilter === "none" || roomFilter === "all" ? undefined : roomFilter)}
                    >
                        <Plus size={14} />
                        <span>新增长期记忆</span>
                    </button>
                </div>
            );
        }
        const groups: Array<{ room?: MemoryRoom; label: string }> = [
            ...MEMORY_ROOMS.map(room => ({ room: room as MemoryRoom, label: MEMORY_ROOM_META[room].label })),
            { room: undefined, label: UNFILED_ROOM_LABEL },
        ];
        return (
            <>
                {groups.map(group => {
                    const items = filtered.filter(entry => (group.room ? entry.room === group.room : !entry.room));
                    if (items.length === 0) return null;
                    const used = items.reduce((sum, entry) => sum + estimateTokens(entry.content) + 4, 0);
                    const budget = group.room ? (config.roomBudgets?.[group.room] ?? 0) : 0;
                    const over = group.room ? used > budget : false;
                    return (
                        <div key={group.room ?? "unfiled"} className="mem-room-group">
                            <div className="mem-room-group-head">
                                <span className="mem-room-group-icon"><Home size={13} strokeWidth={1.8} /></span>
                                <span className="mem-room-group-name">{group.label}</span>
                                <span className="mem-room-group-stat">
                                    {items.length} 条 · ~{used} tk
                                    {group.room ? ` / 预算 ${budget}` : ""}
                                </span>
                                <button
                                    className="mem-room-group-add"
                                    onClick={() => openCreateMemoryEditor("long_term", group.room)}
                                    title="在此房间新增记忆"
                                >
                                    <Plus size={14} />
                                </button>
                            </div>
                            {over ? <p className="mem-room-group-warn">已超出该房间预算，注入时会被截断。</p> : null}
                            {items.map(entry => renderEntryCard(entry))}
                        </div>
                    );
                })}
            </>
        );
    };

    const renderMemoryEntries = (type: MemoryEntry["type"], entries: MemoryEntry[], emptyText: string) => {
        const label = type === "core" ? "核心记忆" : "长期记忆";
        const roomMode = type === "long_term" && config.roomEnabled;
        return (
            <>
                {entries.length > 0 && (
                    <div className="mem-entry-toolbar">
                        <button
                            className="mem-entry-add-btn"
                            onClick={() => openCreateMemoryEditor(type)}
                        >
                            <Plus size={15} strokeWidth={1.8} />
                            <span>新增{label}</span>
                        </button>
                        <button
                            className="mem-entry-clear-btn"
                            onClick={() => setConfirmClearAll(true)}
                        >
                            <Trash2 size={15} strokeWidth={1.8} />
                            <span>清除{label}</span>
                        </button>
                    </div>
                )}
                {roomMode ? (
                    <div className="mem-room-chips">
                        <button
                            className="ui-chip"
                            {...(roomFilter === "all" ? { "data-selected": "" } : {})}
                            onClick={() => setRoomFilter("all")}
                        >
                            全部
                        </button>
                        {MEMORY_ROOMS.map(room => {
                            const count = entries.filter(entry => entry.room === room).length;
                            if (count === 0 && roomFilter !== room) return null;
                            return (
                                <button
                                    key={room}
                                    className="ui-chip"
                                    {...(roomFilter === room ? { "data-selected": "" } : {})}
                                    onClick={() => setRoomFilter(room)}
                                >
                                    {MEMORY_ROOM_META[room].label} {count}
                                </button>
                            );
                        })}
                        {(() => {
                            const unfiledCount = entries.filter(entry => !entry.room).length;
                            if (unfiledCount === 0) return null;
                            return (
                                <button
                                    className="ui-chip is-unfiled"
                                    {...(roomFilter === "none" ? { "data-selected": "" } : {})}
                                    onClick={() => setRoomFilter("none")}
                                >
                                    {UNFILED_ROOM_LABEL} {unfiledCount}
                                </button>
                            );
                        })()}
                    </div>
                ) : null}
                {entryMenuId && (
                    <button
                        className="mem-entry-menu-backdrop"
                        aria-label="关闭菜单"
                        onClick={() => setEntryMenuId(null)}
                    />
                )}
                {entries.length === 0 ? (
                    <div className="mem-empty-card">
                        <p>{emptyText}</p>
                        <button className="mem-empty-add-btn" onClick={() => openCreateMemoryEditor(type)}>
                            <Plus size={14} />
                            <span>新增{label}</span>
                        </button>
                    </div>
                ) : roomMode ? (
                    renderRoomsGroupedEntries(entries)
                ) : (
                    entries.map(entry => renderEntryCard(entry))
                )}
            </>
        );
    };


    // ── Detail View ──
    if (view === "detail" && selectedChar) {
        return (
            <div className="flex flex-col absolute inset-0 overflow-hidden" style={{ padding: "0 16px" }}>
                {/* Content */}
                <div className="memory-detail-scroll flex-1 overflow-y-auto flex flex-col gap-2 min-h-0">
                    <MemoryDetailBoundary>
                    {loading ? (
                        <p className="text-center ts-14 mt-10 text-secondary">
                            加载中...
                        </p>
                    ) : activeTab === "short" ? (
                        /* ── Short-term: card view ── */
                        <>
                            <MemoryTimeline
                                events={shortTermEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                            />
                        </>
                    ) : activeTab === "shared" ? (
                        /* ── Shared events: card view ── */
                        sharedEvents.length === 0 ? (
                            <p className="text-center ts-14 mt-10 text-secondary">
                                暂无共享事件。用户发朋友圈或参与群聊后会自动显示。
                            </p>
                        ) : (
                            <MemoryTimeline
                                events={sharedEvents}
                                userName={resolveUserIdentity(selectedCharId!)?.name || "用户"}
                            />
                        )
                    ) : activeTab === "core" ? (
                        renderMemoryEntries("core", coreEntries, "暂无核心记忆。长期记忆累计到设定条数后会自动提炼，也可以手动新增。")
                    ) : (
                        /* ── Long-term: Summarized Memories ── */
                        renderMemoryEntries("long_term", longTermEntries, "暂无长期记忆。点击设置页的手动总结，或直接新增一条记忆。")
                    )}
                    </MemoryDetailBoundary>
                </div>

                {/* Bottom tab bar — floating above bottom */}
                <div className="chat-tab-bar" style={{ position: "absolute", bottom: 40, left: 40, right: 40, zIndex: 10, borderRadius: 28, borderTop: "none", padding: "10px 0" }}>
                    {([
                        { key: "short" as const, icon: Clock, label: "短期" },
                        { key: "shared" as const, icon: Users, label: "共享事件" },
                        { key: "long" as const, icon: Archive, label: "长期" },
                        { key: "core" as const, icon: Archive, label: "核心" },
                    ]).map(tab => (
                        <button
                            key={tab.key}
                            className={`chat-tab${activeTab === tab.key ? " chat-tab-active" : ""}`}
                            onClick={() => {
                                setActiveTab(tab.key);
                                setEntryMenuId(null);
                                setRoomFilter("all");
                            }}
                        >
                            <tab.icon size={18} />
                            <span>{tab.label}</span>
                        </button>
                    ))}
                </div>

                {/* Manual memory editor */}
                {memoryEditor && (() => {
                    const isCore = memoryEditor.type === "core";
                    const isEdit = Boolean(memoryEditor.entry);
                    const title = `${isEdit ? "编辑" : "新增"}${isCore ? "核心记忆" : "长期记忆"}`;
                    const placeholder = isCore
                        ? "记录稳定、长期影响角色判断的事实，例如关系身份、重大约定、长期设定。"
                        : "记录一次重要事件、承诺、偏好、关系变化，后续对话会参考。";
                    const contentLength = memoryEditor.content.trim().length;
                    const overLimit = contentLength > MANUAL_MEMORY_CONTENT_LIMIT;
                    return (
                        <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => savingMemory ? undefined : setMemoryEditor(null)}>
                            <div className="modal-sheet mem-edit-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                <div className="modal-header" data-ui="modal-header">
                                    <button
                                        className="modal-header-btn modal-header-btn-muted"
                                        onClick={() => setMemoryEditor(null)}
                                        disabled={savingMemory}
                                    >
                                        <X size={18} />
                                    </button>
                                    <h3 className="modal-title">{title}</h3>
                                    <button
                                        className="modal-header-btn modal-header-btn-action"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || !contentLength || overLimit}
                                    >
                                        <Check size={18} />
                                    </button>
                                </div>
                                <div className="modal-body mem-edit-body" data-ui="modal-body">
                                    <textarea
                                        className="ui-textarea mem-edit-textarea"
                                        value={memoryEditor.content}
                                        placeholder={placeholder}
                                        disabled={savingMemory}
                                        onChange={event => setMemoryEditor(prev => prev ? { ...prev, content: event.target.value } : prev)}
                                    />
                                    {!isCore && config.roomEnabled ? (
                                        <div className="mem-edit-rooms">
                                            <p className="mem-edit-rooms-title">存放房间</p>
                                            <div className="mem-edit-rooms-chips">
                                                {MEMORY_ROOMS.map(room => (
                                                    <button
                                                        key={room}
                                                        type="button"
                                                        className="ui-chip"
                                                        {...(memoryEditor.room === room ? { "data-selected": "" } : {})}
                                                        onClick={() => setMemoryEditor(prev => prev ? { ...prev, room } : prev)}
                                                    >
                                                        {MEMORY_ROOM_META[room].label}
                                                    </button>
                                                ))}
                                                <button
                                                    type="button"
                                                    className="ui-chip is-unfiled"
                                                    {...(memoryEditor.room ? {} : { "data-selected": "" })}
                                                    onClick={() => setMemoryEditor(prev => {
                                                        if (!prev) return prev;
                                                        const copy = { ...prev };
                                                        delete copy.room;
                                                        return copy;
                                                    })}
                                                >
                                                    {UNFILED_ROOM_LABEL}
                                                </button>
                                            </div>
                                        </div>
                                    ) : null}
                                    <div className={`mem-edit-footer ${overLimit ? "is-over-limit" : ""}`}>
                                        <span>{isCore ? "CORE" : "LONG TERM"}</span>
                                        <span>{contentLength}/{MANUAL_MEMORY_CONTENT_LIMIT}</span>
                                    </div>
                                    <button
                                        className="ui-btn ui-btn-primary mem-edit-save-btn"
                                        onClick={handleSaveManualMemory}
                                        disabled={savingMemory || !contentLength || overLimit}
                                    >
                                        {savingMemory ? "保存中..." : "保存记忆"}
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {/* Confirm delete single entry */}
                {confirmDeleteEntryId && (
                    <ConfirmDialog
                        title="确认删除？"
                        message="删除记忆条目后无法恢复。是否继续？"
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认删除"
                        onConfirm={() => {
                            handleDeleteEntry(confirmDeleteEntryId);
                            setConfirmDeleteEntryId(null);
                        }}
                        onCancel={() => setConfirmDeleteEntryId(null)}
                    />
                )}

                {/* Confirm clear all long-term entries */}
                {confirmClearAll && (
                    <ConfirmDialog
                        title="确认清除？"
                        message={activeTab === "core" ? "将清除该角色所有核心记忆，此操作无法恢复。" : "将清除该角色所有长期记忆，此操作无法恢复。"}
                        icon={AlertCircle}
                        variant="danger"
                        confirmLabel="确认清除"
                        onConfirm={() => {
                            handleClearEntries(activeTab === "core" ? "core" : "long_term");
                            setConfirmClearAll(false);
                        }}
                        onCancel={() => setConfirmClearAll(false)}
                    />
                )}
            </div>
        );
    }

    // ── Settings View ──
    if (view === "settings") {
        const currentPrompt = editingPrompt ?? config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT;
        const currentCorePrompt = editingCorePrompt ?? config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT;
        const isModified = currentPrompt !== (config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT);
        const isDefault = (config.summarizationPrompt ?? DEFAULT_SUMMARIZATION_PROMPT) === DEFAULT_SUMMARIZATION_PROMPT;
        const isCoreModified = currentCorePrompt !== (config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT);
        const isCoreDefault = (config.coreMemoryPrompt ?? DEFAULT_CORE_MEMORY_PROMPT) === DEFAULT_CORE_MEMORY_PROMPT;

        return (
            <div className="page-menu memory-settings-menu">
                {/* Manual summarize */}
                {selectedCharId && (
                    <>
                        <p className="menu-group-desc mx-2">手动操作</p>
                        <div className="menu-group">
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Zap} color={BINDING_ACCENTS.memory} />
                                <div className="menu-label-group">
                                    <span className="menu-label">长期记忆手动总结</span>
                                    <span className="menu-desc">将新产生的事件整理为长期记忆</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={() => setSummarizeRangeOpen(true)}
                                        disabled={summarizing}
                                    >
                                        <Zap size={12} className="mr-1" />
                                        {summarizing ? "处理中..." : "总结"}
                                    </button>
                                </div>
                            </div>
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                                <div className="menu-label-group">
                                    <span className="menu-label">核心记忆手动总结</span>
                                    <span className="menu-desc">将长期记忆整理为核心记忆</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={handleManualRebuildCore}
                                        disabled={rebuildingCore}
                                    >
                                        <Archive size={12} className="mr-1" />
                                        {rebuildingCore ? "处理中..." : "重建"}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {summarizeRangeOpen ? (
                            <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSummarizeRangeOpen(false)}>
                                <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                                    <div className="modal-header" data-ui="modal-header">
                                        <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSummarizeRangeOpen(false)}><X size={18} /></button>
                                        <h3 className="modal-title">选择总结范围</h3>
                                        <span style={{ width: 44 }} />
                                    </div>
                                    <div className="modal-body modal-body-tight" data-ui="modal-body">
                                        <div className="menu-group">
                                            {SUMMARIZE_RANGE_OPTIONS.map(option => (
                                                <button
                                                    key={String(option.value)}
                                                    type="button"
                                                    className="menu-item w-full text-left"
                                                    onClick={() => void handleManualSummarize(option.value)}
                                                >
                                                    <div className="menu-label-group">
                                                        <span className="menu-label">{option.label}</span>
                                                        {option.desc ? <span className="menu-desc">{option.desc}</span> : null}
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ) : null}
                    </>
                )}

                {/* Memory source filter — one entry row, full picker lives in a bottom sheet */}
                <p className="menu-group-desc mx-2">记忆来源</p>
                <div className="menu-group">
                    <button type="button" className="menu-item" onClick={() => setSourcePickerOpen(true)}>
                        <MemorySettingsIcon icon={Filter} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">记忆来源</span>
                            <span className="menu-desc">选择哪些内容参与记忆</span>
                        </div>
                        <div className="menu-right">
                            <span className="menu-desc mr-1">{disabledSourceCount === 0 ? "全部开启" : `已关闭 ${disabledSourceCount} 项`}</span>
                            <ChevronRight size={16} />
                        </div>
                    </button>
                </div>

                {sourcePickerOpen ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setSourcePickerOpen(false)}>
                        <div className="modal-sheet memory-source-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <span style={{ width: 28 }} />
                                <h3 className="modal-title">记忆来源</h3>
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => setSourcePickerOpen(false)}><X size={18} /></button>
                            </div>
                            <div className="modal-body modal-body-tight" data-ui="modal-body">
                                <div className="memory-source-chips" style={{ "--chip-accent": BINDING_ACCENTS.memory } as CSSProperties}>
                                    {MEMORY_SOURCE_OPTIONS.map(source => {
                                        const allowed = config.shortTermAllowedSources ?? {};
                                        const isChecked = allowed[source.key] !== false;
                                        return (
                                            <button
                                                key={source.key}
                                                type="button"
                                                className="memory-source-chip"
                                                data-off={isChecked ? undefined : ""}
                                                aria-pressed={isChecked}
                                                onClick={() => {
                                                    const next = {
                                                        ...config,
                                                        shortTermAllowedSources: { ...allowed, [source.key]: !isChecked },
                                                    };
                                                    setConfig(next);
                                                    saveMemoryConfig(next);
                                                }}
                                            >
                                                {source.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* 记忆宫殿：重新归档房间 */}
                {reclassifyScopeOpen ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => reclassifying ? undefined : setReclassifyScopeOpen(false)}>
                        <div className="modal-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => setReclassifyScopeOpen(false)} disabled={reclassifying}><X size={18} /></button>
                                <h3 className="modal-title">重新归档房间</h3>
                                <span style={{ width: 44 }} />
                            </div>
                            <div className="modal-body modal-body-tight" data-ui="modal-body">
                                <p className="menu-group-desc mx-2">
                                    只修改记忆的房间归属，不会重写记忆正文，可以随时重跑。
                                    {config.reclassifySkipManual ? "已开启保护：手动新增/编辑过的条目会被跳过。" : "当前会覆盖手动编辑过的条目。"}
                                </p>
                                <div className="menu-group">
                                    <button
                                        type="button"
                                        className="menu-item w-full text-left"
                                        disabled={reclassifying}
                                        onClick={() => { setReclassifyScopeOpen(false); void handleReclassify("unassigned"); }}
                                    >
                                        <div className="menu-label-group">
                                            <span className="menu-label">只归档未归档的</span>
                                            <span className="menu-desc">默认方式，只处理还没有房间的条目</span>
                                        </div>
                                    </button>
                                    <button
                                        type="button"
                                        className="menu-item w-full text-left"
                                        disabled={reclassifying}
                                        onClick={() => { setReclassifyScopeOpen(false); void handleReclassify("all"); }}
                                    >
                                        <div className="menu-label-group">
                                            <span className="menu-label">重新判定全部</span>
                                            <span className="menu-desc">所有长期记忆重新分房间（更慢，覆盖已有房间）</span>
                                        </div>
                                    </button>
                                </div>
                                <div className="menu-group">
                                    <div className="menu-item">
                                        <MemorySettingsIcon icon={AlertCircle} color={BINDING_ACCENTS.memory} />
                                        <div className="menu-label-group">
                                            <span className="menu-label">保护手动修改</span>
                                            <span className="menu-desc">跳过用户手动新增/编辑过的记忆</span>
                                        </div>
                                        <div className="menu-right">
                                            <Toggle checked={config.reclassifySkipManual !== false} onChange={(v) => {
                                                const next = { ...config, reclassifySkipManual: v };
                                                setConfig(next);
                                                saveMemoryConfig(next);
                                            }} />
                                        </div>
                                    </div>
                                </div>
                                {reclassifyProgress ? (
                                    <p className="menu-group-desc mx-2">{reclassifyProgress}</p>
                                ) : null}
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* 记忆宫殿：房间归档标准 */}
                {roomPromptPickerOpen ? (
                    <div className="modal-overlay modal-overlay-bottom" data-ui="modal" onClick={() => setRoomPromptPickerOpen(false)}>
                        <div className="modal-sheet memory-source-sheet" data-ui="modal-sheet" onClick={event => event.stopPropagation()}>
                            <div className="modal-header" data-ui="modal-header">
                                <span style={{ width: 28 }} />
                                <h3 className="modal-title">房间归档标准</h3>
                                <button className="modal-header-btn modal-header-btn-muted" onClick={() => setRoomPromptPickerOpen(false)}><X size={18} /></button>
                            </div>
                            <div className="modal-body modal-body-tight" data-ui="modal-body">
                                <div className="memory-source-chips" style={{ "--chip-accent": BINDING_ACCENTS.memory } as CSSProperties}>
                                    {MEMORY_ROOMS.map(room => {
                                        const enabled = (config.roomPromptRooms ?? []).includes(room);
                                        return (
                                            <button
                                                key={room}
                                                type="button"
                                                className="memory-source-chip"
                                                data-off={enabled ? undefined : ""}
                                                aria-pressed={enabled}
                                                onClick={() => {
                                                    toggleRoomEnabledForPrompt(room);
                                                    setActiveRoomPrompt(room);
                                                }}
                                            >
                                                {MEMORY_ROOM_META[room].label}
                                            </button>
                                        );
                                    })}
                                </div>
                                <div className="mem-room-prompt-tabs">
                                    {MEMORY_ROOMS.map(room => (
                                        <button
                                            key={room}
                                            type="button"
                                            className={`mem-room-prompt-tab${activeRoomPrompt === room ? " is-active" : ""}`}
                                            onClick={() => setActiveRoomPrompt(room)}
                                        >
                                            {MEMORY_ROOM_META[room].label}
                                        </button>
                                    ))}
                                </div>
                                <textarea
                                    className="ui-textarea w-full min-h-[120px] ts-13 leading-relaxed resize-y mx-2"
                                    style={{ width: "calc(100% - 16px)" }}
                                    value={roomPromptEditing[activeRoomPrompt] ?? config.roomPrompts?.[activeRoomPrompt] ?? MEMORY_ROOM_META[activeRoomPrompt].criteria}
                                    placeholder={MEMORY_ROOM_META[activeRoomPrompt].criteria}
                                    onChange={event => setRoomPromptEditing(prev => ({ ...prev, [activeRoomPrompt]: event.target.value }))}
                                />
                                <p className="menu-group-desc mx-2">
                                    {MEMORY_ROOM_META[activeRoomPrompt].desc}。这段文字会在总结时作为该房间的收录标准送给模型。
                                </p>
                                <div className="px-4 pb-4">
                                    <button
                                        className="ui-btn ui-btn-primary p-2.5 w-full"
                                        onClick={() => saveRoomPrompt(activeRoomPrompt)}
                                        disabled={roomPromptEditing[activeRoomPrompt] === undefined}
                                    >
                                        <Check size={14} className="mr-1.5" /> 保存「{MEMORY_ROOM_META[activeRoomPrompt].label}」标准
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                ) : null}

                {/* 记忆宫殿 */}
                <p className="menu-group-desc mx-2">记忆宫殿</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Home} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">启用记忆宫殿</span>
                            <span className="menu-desc">长期记忆按房间归类、注入时分板块；存量上限会自动放宽 3 倍（房间拆分会让条数变多）</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.roomEnabled === true} onChange={(v) => {
                                let next = { ...config, roomEnabled: v };
                                if (v) {
                                    // 开启时自动补房间版模板（仅当提示词还是出厂原文，不覆盖手改内容）；
                                    // 不打开分房间截断，注入形状优先保持不变。
                                    next = applyRoomPromptTemplate(next, { force: false }).config;
                                }
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    {config.roomEnabled ? (
                        <>
                            <button type="button" className="menu-item" onClick={() => setRoomPromptPickerOpen(true)}>
                                <MemorySettingsIcon icon={FolderOpen} color={BINDING_ACCENTS.preset} />
                                <div className="menu-label-group">
                                    <span className="menu-label">房间归档标准</span>
                                    <span className="menu-desc">每个房间负责收录什么；不勾选的房间不参与总结</span>
                                </div>
                                <div className="menu-right">
                                    <span className="menu-desc mr-1">{config.roomPromptRooms?.length ?? 0} 个房间</span>
                                    <ChevronRight size={16} />
                                </div>
                            </button>
                            <button type="button" className="menu-item" onClick={() => setReclassifyScopeOpen(true)} disabled={reclassifying}>
                                <MemorySettingsIcon icon={Wand2} color={BINDING_ACCENTS.embedding} />
                                <div className="menu-label-group">
                                    <span className="menu-label">重新归档房间</span>
                                    <span className="menu-desc">把已有长期记忆按内容重新分房间（只改房间，不动正文）</span>
                                </div>
                                <div className="menu-right">
                                    <span className="menu-desc mr-1">{reclassifyProgress ?? (reclassifying ? "处理中..." : "未开始")}</span>
                                    <ChevronRight size={16} />
                                </div>
                            </button>
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Wand2} color={BINDING_ACCENTS.api} />
                                <div className="menu-label-group">
                                    <span className="menu-label">套用房间版提示词模板</span>
                                    <span className="menu-desc">把手改过的总结提示词也替换成房间版（会覆盖）</span>
                                </div>
                                <div className="menu-right">
                                    <button
                                        className="ui-btn ui-btn-outline py-1 px-3 ts-12"
                                        onClick={() => handleApplyRoomTemplate(true)}
                                    >
                                        套用
                                    </button>
                                </div>
                            </div>
                        </>
                    ) : null}
                </div>

                {/* Feature toggles */}
                <p className="menu-group-desc mx-2">自动化</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Clock} color={BINDING_ACCENTS.memory} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数自动将新事件整理为长期记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoSummarizeEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoSummarizeEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">核心记忆自动总结</span>
                            <span className="menu-desc">每隔一定条数长期记忆，自动整理为核心记忆</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.autoBuildCoreEnabled ?? true} onChange={(v) => {
                                const next = { ...config, autoBuildCoreEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                    <div className="menu-item">
                        <MemorySettingsIcon icon={Search} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">向量召回</span>
                            <span className="menu-desc">长期记忆超出预算时，通过 embedding 按相关性检索</span>
                        </div>
                        <div className="menu-right">
                            <Toggle checked={config.vectorRecallEnabled ?? true} onChange={(v) => {
                                const next = { ...config, vectorRecallEnabled: v };
                                setConfig(next);
                                saveMemoryConfig(next);
                            }} />
                        </div>
                    </div>
                </div>

                {/* Token budget sliders */}
                <p className="menu-group-desc mx-2">控制截断量</p>
                <div className="menu-group">
                    {config.roomEnabled ? (
                        <div className="menu-item">
                            <MemorySettingsIcon icon={Home} color={BINDING_ACCENTS.memory} />
                            <div className="menu-label-group">
                                <span className="menu-label">分房间截断</span>
                                <span className="menu-desc">关闭时按「长期记忆」总预算整体截断（原行为）</span>
                            </div>
                            <div className="menu-right">
                                <Toggle
                                    checked={config.roomTruncationMode === "perRoom"}
                                    onChange={(v) => {
                                        const next = { ...config, roomTruncationMode: v ? "perRoom" as const : "global" as const };
                                        setConfig(next);
                                        saveMemoryConfig(next);
                                    }}
                                />
                            </div>
                        </div>
                    ) : null}
                    <MemorySettingsSliderItem
                        icon={Users}
                        color={BINDING_ACCENTS.voice}
                        label="短期记忆+最近上下文"
                        desc="聊天历史、朋友圈、群聊与跨应用近期事件截断量"
                        value={config.shortTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.shortTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.shortTermTokenBudget}
                        onChange={value => saveBudget("shortTermTokenBudget", value)}
                    />
                    <MemorySettingsSliderItem
                        icon={Archive}
                        color={BINDING_ACCENTS.memory}
                        label="长期记忆"
                        desc="总结记忆注入量"
                        value={config.longTermTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.longTermTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.longTermTokenBudget}
                        onChange={value => saveBudget("longTermTokenBudget", value)}
                    />
                    <MemorySettingsSliderItem
                        icon={Brain}
                        color={BINDING_ACCENTS.embedding}
                        label="核心记忆"
                        desc="高优先级里程碑注入量"
                        value={config.coreMemoryTokenBudget}
                        min={MEMORY_TOKEN_BUDGET_MIN.coreMemoryTokenBudget}
                        max={MEMORY_TOKEN_BUDGET_MAX}
                        step={MEMORY_TOKEN_BUDGET_STEP.coreMemoryTokenBudget}
                        onChange={value => saveBudget("coreMemoryTokenBudget", value)}
                    />
                </div>

                {/* 记忆宫殿：房间预算与常驻 */}
                {config.roomEnabled && config.roomTruncationMode === "perRoom" ? (
                    <>
                        <p className="menu-group-desc mx-2">房间注入预算（每间单独控制）</p>
                        <div className="menu-group">
                            {MEMORY_ROOMS.map(room => (
                                <div key={room}>
                                    <MemorySettingsSliderItem
                                        icon={Home}
                                        color={BINDING_ACCENTS.memory}
                                        label={MEMORY_ROOM_META[room].label}
                                        desc={MEMORY_ROOM_META[room].desc}
                                        value={config.roomBudgets?.[room] ?? MEMORY_ROOM_META[room].defaultBudget}
                                        min={ROOM_BUDGET_MIN}
                                        max={ROOM_BUDGET_MAX}
                                        step={ROOM_BUDGET_STEP}
                                        onChange={value => saveRoomBudget(room, value)}
                                    />
                                    <div className="menu-item mem-room-resident-row">
                                        <div className="menu-label-group">
                                            <span className="menu-label">常驻（不被挤掉）</span>
                                            <span className="menu-desc">超预算时最后才被剔除</span>
                                        </div>
                                        <div className="menu-right">
                                            <Toggle
                                                checked={config.roomResident?.[room] === true}
                                                onChange={(v) => {
                                                    const next = { ...config, roomResident: { ...config.roomResident, [room]: v } };
                                                    setConfig(next);
                                                    saveMemoryConfig(next);
                                                }}
                                            />
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                ) : null}

                {/* 记忆宫殿：核心记忆来源房间 */}
                {config.roomEnabled ? (
                    <>
                        <p className="menu-group-desc mx-2">核心记忆来源房间</p>
                        <div className="menu-group">
                            <div className="menu-item">
                                <MemorySettingsIcon icon={Brain} color={BINDING_ACCENTS.embedding} />
                                <div className="menu-label-group">
                                    <span className="menu-label">按房间过滤</span>
                                    <span className="menu-desc">只根据勾选的房间提炼核心记忆；关闭＝使用全部长期记忆</span>
                                </div>
                                <div className="menu-right">
                                    <Toggle checked={config.coreMemoryRoomFilterEnabled === true} onChange={(v) => {
                                        const next = { ...config, coreMemoryRoomFilterEnabled: v };
                                        setConfig(next);
                                        saveMemoryConfig(next);
                                    }} />
                                </div>
                            </div>
                            {config.coreMemoryRoomFilterEnabled ? (
                                <div className="memory-source-chips mx-2" style={{ "--chip-accent": BINDING_ACCENTS.embedding } as CSSProperties}>
                                    {MEMORY_ROOMS.map(room => {
                                        const enabled = (config.coreMemoryRooms ?? []).includes(room);
                                        return (
                                            <button
                                                key={room}
                                                type="button"
                                                className="memory-source-chip"
                                                data-off={enabled ? undefined : ""}
                                                aria-pressed={enabled}
                                                onClick={() => toggleCoreMemoryRoom(room)}
                                            >
                                                {MEMORY_ROOM_META[room].label}
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : null}
                        </div>
                    </>
                ) : null}

                {/* Summarization interval */}
                <p className="menu-group-desc mx-2">自动总结间隔</p>
                <div className="menu-group">
                    <MemorySettingsSliderItem
                        icon={Clock}
                        color={BINDING_ACCENTS.api}
                        label="总结间隔"
                        desc="每 N 条事件自动触发总结"
                        value={config.summarizationEventInterval ?? 50}
                        min={10}
                        max={200}
                        step={10}
                        onChange={saveInterval}
                    />
                    <MemorySettingsSliderItem
                        icon={Brain}
                        color={BINDING_ACCENTS.embedding}
                        label="核心记忆总结间隔"
                        desc="每 N 条长期记忆自动触发核心记忆总结"
                        value={config.coreSummarizationInterval ?? 5}
                        min={1}
                        max={20}
                        step={1}
                        onChange={saveCoreInterval}
                    />
                </div>

                {/* Summarization Prompt Editor */}
                <p className="menu-group-desc mx-2">长期记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.preset} />
                        <div className="menu-label-group">
                            <span className="menu-label">长期记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{MEMORY_LONG_TERM_PROMPT_PLACEHOLDERS}
                            </span>
                        </div>
                        {!isDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetPrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentPrompt}
                            onChange={e => setEditingPrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {config.roomEnabled && !hasRoomSpecPlaceholder(currentPrompt) ? (
                            <p className="mem-prompt-hint">
                                这段提示词里没有 {"{{roomSpec}}"}：记忆宫殿开启时，房间规则会在结尾自动追加，所以仍然能正常分房间。
                            </p>
                        ) : null}
                        {isModified && (
                            <button
                                onClick={handleSavePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Zap size={14} className="mr-1.5" /> 保存提词配置
                            </button>
                        )}
                    </div>
                </div>

                <p className="menu-group-desc mx-2">核心记忆提示词</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <MemorySettingsIcon icon={FileText} color={BINDING_ACCENTS.embedding} />
                        <div className="menu-label-group">
                            <span className="menu-label">核心记忆总结提示词</span>
                            <span className="menu-desc">
                                变量：{MEMORY_CORE_PROMPT_PLACEHOLDERS}
                            </span>
                        </div>
                        {!isCoreDefault && (
                            <div className="menu-right">
                                <button onClick={handleResetCorePrompt} className="menu-label menu-label-danger ts-12 underline">
                                    恢复默认
                                </button>
                            </div>
                        )}
                    </div>
                    <div className="px-4 pb-4 flex flex-col gap-3">
                        <textarea
                            value={currentCorePrompt}
                            onChange={e => setEditingCorePrompt(e.target.value)}
                            className="ui-textarea w-full min-h-[200px] ts-14 leading-relaxed resize-y"
                        />
                        {config.coreMemoryRoomFilterEnabled ? (
                            <p className="mem-prompt-hint">
                                已开启按房间过滤：{"{{rooms}}"} 会替换成来源房间说明，当前来源为
                                「{MEMORY_ROOMS.filter(room => (config.coreMemoryRooms ?? []).includes(room)).map(room => MEMORY_ROOM_META[room].label).join("、")}」。
                            </p>
                        ) : null}
                        {isCoreModified && (
                            <button
                                onClick={handleSaveCorePrompt}
                                className="ui-btn ui-btn-primary p-2.5 w-full"
                            >
                                <Archive size={14} className="mr-1.5" /> 保存核心记忆提词配置
                            </button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // ── Character List View ──
    return (
        <div className="mem-picker">
            <div className="mem-picker-card">
                <p className="mem-picker-cover-title">Every moment we shared becomes a timeless memory</p>
                <div className="mem-picker-divider"><span>✦</span></div>
                <div className="mem-picker-cover-wrap">
                    {"MEMORY".split("").map((ch, i) => (
                        <span key={i} className={`mem-picker-cover-letter mem-picker-letter-${i}`}>{ch}</span>
                    ))}
                    <div className="mem-picker-cover-clip">
                        {(() => {
                            const coverSrc = pickedCharId
                                ? (characters.find(c => c.character.id === pickedCharId)?.character.avatar || "")
                                : (resolveUserIdentity()?.avatarUrl || "");
                            return coverSrc ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                    src={coverSrc}
                                    alt=""
                                    className="mem-picker-cover"
                                    draggable={false}
                                />
                            ) : null;
                        })()}
                    </div>
                </div>

                <div className="mem-picker-body">
                    <p className="mem-picker-prompt">
                        你想查看谁的记忆呢？<br />
                        <span className="mem-picker-hint">点击TA的卡片查看吧</span>
                    </p>

                    <div className="mem-picker-chips">
                        {characters.map(({ character }) => (
                            <button
                                key={character.id}
                                className="ui-chip"
                                {...(pickedCharId === character.id ? { "data-selected": "" } : {})}
                                onClick={() => setPickedCharId(pickedCharId === character.id ? null : character.id)}
                            >
                                {character.name}
                            </button>
                        ))}
                    </div>

                    <div className="mem-picker-tear">
                        <div className="mem-picker-tear-line"><span>✦</span></div>
                    </div>

                    <div className="mem-picker-action">
                        <button
                            className="ui-chip ui-chip-lg"
                            {...(pickedCharId ? { "data-selected": "" } : {})}
                            onClick={() => pickedCharId && handleSelectChar(loadCharacters().find(c => c.id === pickedCharId)!)}
                        >
                            查看TA的记忆
                        </button>
                    </div>

                    <div className="mem-picker-footer">
                        <span>OBSERVER · 记忆观察员</span>
                        <span>{characters.length} PROFILES · {characters.reduce((s, c) => s + c.shortTermCount + c.coreCount + c.longTermCount, 0)} RECORDS</span>
                        <span>{new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" })}</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
