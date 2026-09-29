// lib/memory-room.ts
// 记忆宫殿（Memory Palace）房间定义与解析工具。
//
// 设计要点：
// - 房间是「长期记忆的一个标签」，不是新的存储层。一条记忆只有一个主房间。
// - 房间规则通过 {{roomSpec}} 占位符在总结时**运行时**生成，
//   因此用户在设置里改房间提示词/勾选房间，不需要改写模板正文。
// - 解析支持 [客厅] / 【客厅】 / ## 客厅 / living 等写法。

import type { MemoryRoom, MemoryConfig } from "./memory-types";

export const MEMORY_ROOMS: MemoryRoom[] = [
    "living",
    "bedroom",
    "collection",
    "self",
    "study",
    "windowsill",
];

export type MemoryRoomMeta = {
    id: MemoryRoom;
    /** 方括号里输出的房间名，也是 UI 显示名 */
    label: string;
    /** 设置页里的用途说明 */
    desc: string;
    /** 默认归档标准（用户可在设置里改） */
    criteria: string;
    /** 建议的注入预算（token） */
    defaultBudget: number;
    /** 默认是否常驻（常驻房间优先占位、不受房间淘汰影响） */
    defaultResident: boolean;
};

export const MEMORY_ROOM_META: Record<MemoryRoom, MemoryRoomMeta> = {
    living: {
        id: "living",
        label: "客厅",
        desc: "日常闲聊、近期互动",
        criteria: "日常闲聊、近期互动、生活流水、随口的小事",
        defaultBudget: 600,
        defaultResident: false,
    },
    bedroom: {
        id: "bedroom",
        label: "卧室",
        desc: "亲密情感、深层羁绊",
        criteria: "亲密情感、深层羁绊、关系里程碑与情绪联结",
        defaultBudget: 500,
        defaultResident: false,
    },
    collection: {
        id: "collection",
        label: "收藏室",
        desc: "用户个人信息、习惯、成就与进步",
        criteria: "用户提供的个人信息、固定偏好、生活习惯、成就与进步",
        defaultBudget: 800,
        defaultResident: true,
    },
    self: {
        id: "self",
        label: "自我房间",
        desc: "角色自我认同、演变、潜意识",
        criteria: "角色对自己的认知、性格演变、潜意识与内心矛盾",
        defaultBudget: 300,
        defaultResident: true,
    },
    study: {
        id: "study",
        label: "书房",
        desc: "工作学习、技能成长",
        criteria: "工作、学习、技能成长、知识性交流",
        defaultBudget: 400,
        defaultResident: false,
    },
    windowsill: {
        id: "windowsill",
        label: "窗台",
        desc: "期盼、目标、憧憬",
        criteria: "期盼、目标、憧憬、尚未完成的约定",
        defaultBudget: 200,
        defaultResident: true,
    },
};

/** 房间配色（UI 用）：accent 用于标题/图标，soft 用于卡片底色 */
export const MEMORY_ROOM_COLORS: Record<MemoryRoom, { accent: string; soft: string }> = {
    living: { accent: "#8fb8d8", soft: "rgba(143,184,216,0.14)" },
    bedroom: { accent: "#c9a3d8", soft: "rgba(201,163,216,0.14)" },
    collection: { accent: "#dcc07f", soft: "rgba(220,192,127,0.14)" },
    self: { accent: "#87cbb4", soft: "rgba(135,203,180,0.14)" },
    study: { accent: "#9fb6dd", soft: "rgba(159,182,221,0.14)" },
    windowsill: { accent: "#e8ae9a", soft: "rgba(232,174,154,0.14)" },
};

/** 未归档分组的配色（与房间区分开） */
export const UNFILED_ROOM_COLORS = { accent: "#9a9a9a", soft: "rgba(154,154,154,0.12)" };

/** 房间预算滑块范围（UI 用） */
export const ROOM_BUDGET_MIN = 0;
export const ROOM_BUDGET_MAX = 3000;
export const ROOM_BUDGET_STEP = 100;

/** 未归档分组的显示名（room 为空的旧数据） */
export const UNFILED_ROOM_LABEL = "未归档";

/**
 * 记忆宫殿开启后，单次总结会按房间拆成多条 long_term，
 * 存量条数膨胀约 2~3 倍。若沿用原来的 maxLongTermEntries（默认 500），
 * 历史记忆会被淘汰得更快——所以开启时把有效上限放大这个倍数。
 * 设置页会把这个行为写清楚。
 */
export const ROOM_ENTRY_LIMIT_MULTIPLIER = 3;

export function isMemoryRoom(value: unknown): value is MemoryRoom {
    return typeof value === "string" && (MEMORY_ROOMS as string[]).includes(value);
}

/** 宽容地把任意值转成房间 id；无法识别返回 undefined（= 未归档）。 */
export function normalizeMemoryRoom(value: unknown): MemoryRoom | undefined {
    if (value === null || value === undefined) return undefined;
    const raw = String(value).trim();
    if (!raw) return undefined;
    if (isMemoryRoom(raw)) return raw;
    const lowered = raw.toLowerCase();
    if (isMemoryRoom(lowered)) return lowered;
    for (const room of MEMORY_ROOMS) {
        const meta = MEMORY_ROOM_META[room];
        if (meta.label === raw || lowered === meta.label.toLowerCase()) return room;
    }
    return undefined;
}

export function memoryRoomLabel(room: MemoryRoom | undefined): string {
    if (!room) return UNFILED_ROOM_LABEL;
    return MEMORY_ROOM_META[room]?.label ?? UNFILED_ROOM_LABEL;
}

export function defaultRoomBudgets(): Record<MemoryRoom, number> {
    const result = {} as Record<MemoryRoom, number>;
    for (const room of MEMORY_ROOMS) result[room] = MEMORY_ROOM_META[room].defaultBudget;
    return result;
}

export function defaultRoomResidentFlags(): Record<MemoryRoom, boolean> {
    const result = {} as Record<MemoryRoom, boolean>;
    for (const room of MEMORY_ROOMS) result[room] = MEMORY_ROOM_META[room].defaultResident;
    return result;
}

export function defaultRoomPrompts(): Record<MemoryRoom, string> {
    const result = {} as Record<MemoryRoom, string>;
    for (const room of MEMORY_ROOMS) result[room] = MEMORY_ROOM_META[room].criteria;
    return result;
}

/** 补齐缺失的房间配置项（老配置 / 部分字段缺失时用）。 */
export function normalizeRoomBudgets(value: unknown): Record<MemoryRoom, number> {
    const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const result = defaultRoomBudgets();
    for (const room of MEMORY_ROOMS) {
        const parsed = Number(source[room]);
        if (Number.isFinite(parsed)) {
            result[room] = Math.max(ROOM_BUDGET_MIN, Math.min(ROOM_BUDGET_MAX, Math.round(parsed)));
        }
    }
    return result;
}

export function normalizeRoomFlags(value: unknown): Record<MemoryRoom, boolean> {
    const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const result = defaultRoomResidentFlags();
    for (const room of MEMORY_ROOMS) {
        if (typeof source[room] === "boolean") result[room] = source[room] as boolean;
    }
    return result;
}

export function normalizeRoomPrompts(value: unknown): Record<MemoryRoom, string> {
    const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const result = defaultRoomPrompts();
    for (const room of MEMORY_ROOMS) {
        const text = typeof source[room] === "string" ? source[room] : "";
        if (text.trim()) result[room] = text;
    }
    return result;
}

/** 归一化房间 id 列表；空/非法则回退到全部房间。 */
export function normalizeRoomList(value: unknown, fallback: MemoryRoom[] = MEMORY_ROOMS): MemoryRoom[] {
    if (!Array.isArray(value)) return [...fallback];
    const seen = new Set<MemoryRoom>();
    const result: MemoryRoom[] = [];
    for (const item of value) {
        const room = normalizeMemoryRoom(item);
        if (!room || seen.has(room)) continue;
        seen.add(room);
        result.push(room);
    }
    return result.length > 0 ? result : [...fallback];
}

/** 参与总结/注入的房间（保持 MEMORY_ROOMS 的固定顺序）。 */
export function resolveActiveRooms(config: MemoryConfig | null | undefined): MemoryRoom[] {
    const configured = normalizeRoomList(config?.roomPromptRooms, MEMORY_ROOMS);
    const set = new Set(configured);
    return MEMORY_ROOMS.filter(room => set.has(room));
}

/** 核心记忆喂料房间（未启用过滤时＝全部，保持旧行为）。 */
export function resolveCoreMemoryRooms(config: MemoryConfig | null | undefined): MemoryRoom[] {
    if (!config?.coreMemoryRoomFilterEnabled) return [...MEMORY_ROOMS];
    return MEMORY_ROOMS.filter(room => normalizeRoomList(config?.coreMemoryRooms, MEMORY_ROOMS).includes(room));
}

export function resolveRoomBudgets(config: MemoryConfig | null | undefined): Record<MemoryRoom, number> {
    return normalizeRoomBudgets(config?.roomBudgets);
}

export function isRoomResident(config: MemoryConfig | null | undefined, room: MemoryRoom): boolean {
    return normalizeRoomFlags(config?.roomResident)[room] === true;
}

/**
 * 生成 {{roomSpec}} —— 长期记忆总结时的房间路由规则。
 */
export function buildRoomSpecText(config: MemoryConfig | null | undefined): string {
    const rooms = resolveActiveRooms(config);
    if (rooms.length === 0) return "";
    const prompts = normalizeRoomPrompts(config?.roomPrompts);
    const lines: string[] = [];
    lines.push("【房间划分】每条记忆只归入一个最贴切的房间，房间标题必须按下面的方括号原样写出：");
    for (const room of rooms) {
        const meta = MEMORY_ROOM_META[room];
        const criteria = (prompts[room] || "").trim() || meta.criteria;
        lines.push(`[${meta.label}] ${criteria}`);
    }
    lines.push("");
    lines.push("【硬性规则】");
    lines.push("- 只输出有内容的房间；没有内容的房间整段省略，不要输出空标题、不要写“无”");
    lines.push("- 同一件事只写进一个房间，禁止在多个房间重复出现同一内容");
    lines.push("- 用户提供的个人信息、长期习惯、成就与进步一律归入 [收藏室]");
    lines.push("- 角色对自己的认知、性格演变、潜意识与内心矛盾一律归入 [自我房间]");
    lines.push("- 期盼、目标、憧憬、尚未完成的约定一律归入 [窗台]");
    lines.push("- 每个房间 60-150 字；确实没有可写内容就整个省略该房间，不要硬凑");
    lines.push(`- 每个房间正文之后另起一行，输出 ${MEMORY_TAG_MAX} 个以内的标签，形如：#标签1 #标签2（标签是 2-6 字的短词，用于日后检索，不要带标点）`);
    lines.push("- 标签行必须是该房间内容的最后一行；除房间标题和标签行外，正文不要加任何格式标记");
    return lines.join("\n");
}

/** 每个房间最多保留的标签数 */
export const MEMORY_TAG_MAX = 4;

/** 归一化标签：去掉 # 与前缀空白、限长、去重、限量。 */
export function normalizeMemoryTags(value: unknown, limit: number = MEMORY_TAG_MAX): string[] {
    const rawList: string[] = Array.isArray(value)
        ? value.map(item => String(item ?? ""))
        : String(value ?? "").split(/[\s,，、]+/);
    const result: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawList) {
        const tag = raw.replace(/^[#＃\s]+/, "").replace(/[。，,；;：:！!？?]+$/g, "").trim();
        if (!tag || tag.length > 12) continue;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(tag);
        if (result.length >= limit) break;
    }
    return result;
}

/** 一行是否整体是标签行（#甲 #乙 / ＃甲）。 */
function isTagOnlyLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed || !/^[#＃]/.test(trimmed)) return false;
    const tokens = trimmed.split(/\s+/);
    return tokens.every(token => /^[#＃]\S+$/.test(token));
}

/**
 * 从一段房间正文里抽出标签行。
 * 只认「整行都是 #标签」的行，避免把含 # 的正常句子误判成标签。
 */
export function extractMemoryTags(content: string): { content: string; tags: string[] } {
    const lines = String(content ?? "").replace(/\r\n?/g, "\n").split("\n");
    const tagLines: string[] = [];
    const bodyLines: string[] = [];
    for (const line of lines) {
        if (isTagOnlyLine(line)) {
            tagLines.push(line);
            continue;
        }
        bodyLines.push(line);
    }
    const tags = normalizeMemoryTags(tagLines.join(" "));
    return {
        content: bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
        tags,
    };
}

/**
 * 生成 {{rooms}} —— 核心记忆总结时的「只总结这些房间」说明。
 * 未启用房间过滤时返回空串（模板里那一行会被整行去掉）。
 */
export function buildCoreRoomScopeText(config: MemoryConfig | null | undefined): string {
    if (!config?.coreMemoryRoomFilterEnabled) return "";
    const rooms = resolveCoreMemoryRooms(config);
    if (rooms.length === 0) return "";
    if (rooms.length === MEMORY_ROOMS.length) return "";
    const labels = rooms.map(room => `[${MEMORY_ROOM_META[room].label}]`);
    return `【来源限定】只根据以下房间的长期记忆整理核心记忆：${labels.join("、")}。其余房间的记忆本次不要使用。`;
}

// ── 输出解析 ─────────────────────────────────

const NO_CONTENT_PATTERNS = /^(无|没有|暂无|none|null|n\/a|—|-{1,3}|（无）|\(无\)|\[无\])$/i;

function isNoContent(text: string): boolean {
    const trimmed = text.replace(/[\s*。.]/g, "");
    return trimmed === "" || NO_CONTENT_PATTERNS.test(trimmed);
}

/** 判断一行是否是房间标题，返回房间 id。 */
function matchRoomHeader(line: string): MemoryRoom | undefined {
    let text = line.trim();
    if (!text) return undefined;
    // markdown 标题
    if (text.startsWith("#")) text = text.replace(/^#+/, "").trim();
    // 常见包裹
    text = text.replace(/^\*\*(.*?)\*\*$/, "$1").trim();
    const brackets: Array<[string, string]> = [["[", "]"], ["【", "】"], ["<", ">"], ["〔", "〕"]];
    for (const [open, close] of brackets) {
        if (text.startsWith(open) && text.endsWith(close) && text.length > 2) {
            const inner = text.slice(open.length, text.length - close.length).trim();
            const room = normalizeMemoryRoom(inner);
            if (room) return room;
        }
    }
    // 裸标签：客厅 / 客厅：
    const bare = text.replace(/[：:。，,]$/, "").trim();
    if (bare.length <= 12) {
        const room = normalizeMemoryRoom(bare);
        if (room) return room;
    }
    return undefined;
}

export type ParsedRoomSection = {
    /** undefined = 未能识别房间（未归档） */
    room?: MemoryRoom;
    content: string;
};

/**
 * 把模型输出切成房间段落。
 * - 识别到房间标题 → 按房间返回多条
 * - 完全没识别到标题 → 返回单条 room=undefined（未归档），内容为全文
 */
export function parseRoomSections(raw: string): ParsedRoomSection[] {
    const text = String(raw ?? "").replace(/\r\n?/g, "\n").trim();
    if (!text) return [];

    const sections: Array<{ room?: MemoryRoom; lines: string[] }> = [];
    let current: { room?: MemoryRoom; lines: string[] } | null = null;
    let sawHeader = false;

    for (const line of text.split("\n")) {
        const room = matchRoomHeader(line);
        if (room !== undefined) {
            sawHeader = true;
            current = { room, lines: [] };
            sections.push(current);
            continue;
        }
        if (!current) {
            current = { lines: [] };
            sections.push(current);
        }
        current.lines.push(line);
    }

    const cleaned: ParsedRoomSection[] = [];
    for (const section of sections) {
        const content = section.lines.join("\n").trim();
        if (!content || isNoContent(content)) continue;
        cleaned.push({ room: section.room, content });
    }

    if (!sawHeader) {
        const merged = cleaned.map(item => item.content).join("\n").trim();
        return merged ? [{ room: undefined, content: merged }] : [];
    }
    return cleaned;
}

/** 把「已经总结好的长文本」也当模板用：导出房间清单给 UI 展示。 */
export function roomSpecPreview(config: MemoryConfig | null | undefined): string {
    return buildRoomSpecText(config);
}
