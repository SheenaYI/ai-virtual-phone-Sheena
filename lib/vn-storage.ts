import Dexie from "dexie";
import { formatChatTimestamp } from "./llm-prompt-assembler";
import { estimateValueBytes } from "./data-management/serializers";
import type { VnSession, VnMessage, VnChapterMeta, VnLayoutPrefs, VnBeat, VnFrameAudio } from "./vn-types";
export type { VnSession, VnMessage, VnChapterMeta, VnLayoutPrefs, VnBeat };

class VnDatabase extends Dexie {
  sessions!: Dexie.Table<VnSession, string>;
  messages!: Dexie.Table<VnMessage, string>;
  config!: Dexie.Table<{ key: string; value: string }, string>;

  constructor() {
    super("AiPhoneVnDB");
    this.version(1).stores({
      sessions: "id, characterId, updatedAt",
      messages: "id, sessionId, chapterIndex, createdAt",
    });
    this.version(2).stores({
      sessions: "id, characterId, updatedAt",
      messages: "id, sessionId, chapterIndex, createdAt",
      config: "key",
    });
  }
}

const vnDb = new VnDatabase();

let _hydrated = false;
let _sessionsCache: VnSession[] = [];
let _messagesCache: VnMessage[] = [];

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function parseTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function getVnSessionActivityTime(session: VnSession): number {
  const lastMessageTime = _messagesCache
    .filter((message) => message.sessionId === session.id)
    .reduce((latest, message) => Math.max(latest, parseTime(message.createdAt)), 0);
  return Math.max(lastMessageTime, parseTime(session.updatedAt));
}

function isPreferredVnSession(candidate: VnSession, current: VnSession): boolean {
  // 章节数优先：空壳会话（chapters 为空）绝不能顶掉有内容的存档。
  // 空壳通常来自水合完成前 createOrGetVnSession 抢先新建的那一个——它的
  // updatedAt 是「刚刚」，活跃时间天然更高，只比时间它必赢，真存档随之被清。
  const candidateChapters = candidate.chapters?.length ?? 0;
  const currentChapters = current.chapters?.length ?? 0;
  if (candidateChapters !== currentChapters) return candidateChapters > currentChapters;
  const candidateTime = getVnSessionActivityTime(candidate);
  const currentTime = getVnSessionActivityTime(current);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  const candidateUpdated = parseTime(candidate.updatedAt);
  const currentUpdated = parseTime(current.updatedAt);
  if (candidateUpdated !== currentUpdated) return candidateUpdated > currentUpdated;
  return candidate.id.localeCompare(current.id) > 0;
}

function normalizeVnSessions(sessions: VnSession[]): { items: VnSession[]; changed: boolean } {
  const normalized: VnSession[] = [];
  const indexByCharacter = new Map<string, number>();
  let changed = false;

  for (const session of sessions) {
    const id = session.id?.trim();
    const characterId = session.characterId?.trim();
    if (!id || !characterId) {
      changed = true;
      continue;
    }
    const item = id === session.id && characterId === session.characterId
      ? session
      : { ...session, id, characterId };
    const existingIndex = indexByCharacter.get(characterId);
    if (existingIndex === undefined) {
      indexByCharacter.set(characterId, normalized.length);
      normalized.push(item);
      if (item !== session) changed = true;
      continue;
    }

    changed = true;
    if (isPreferredVnSession(item, normalized[existingIndex])) {
      normalized[existingIndex] = item;
    }
  }

  return { items: normalized, changed };
}

/**
 * 落盘会话快照。只按 id 精确删除被淘汰的行，绝不再 clear() 整表——
 * 原来「清空 + 重写」的写法一旦快照算错，就是整张会话表（章节、总结）永久蒸发。
 */
function persistVnSessionsSnapshot(sessions: VnSession[]): void {
  const keep = new Set(sessions.map((row) => row.id));
  vnDb.transaction("rw", vnDb.sessions, async () => {
    const existing = await vnDb.sessions.toArray();
    const stale = existing.filter((row) => !keep.has(row.id)).map((row) => row.id);
    if (stale.length > 0) await vnDb.sessions.bulkDelete(stale);
    await vnDb.sessions.bulkPut(sessions);
  }).catch(() => undefined);
}

export async function hydrateVnStorage(): Promise<void> {
  if (_hydrated || typeof window === "undefined") return;
  let sessions: VnSession[];
  let messages: VnMessage[];
  try {
    [sessions, messages] = await Promise.all([
      vnDb.sessions.toArray(),
      vnDb.messages.toArray(),
    ]);
  } catch {
    // 读失败绝不标记已水合：保持未水合，下次调用重试。
    // 以前用 .catch(() => []) 把失败吞成空数组，空数组会被当成事实写回库里，
    // 于是「读不到」直接变成「数据被清空」——这是最危险的一条。
    return;
  }
  _messagesCache = messages;
  const normalized = normalizeVnSessions(sessions);
  _sessionsCache = normalized.items;
  if (normalized.changed) persistVnSessionsSnapshot(normalized.items);
  _hydrated = true;
}

export function loadVnSessions(): VnSession[] {
  const normalized = normalizeVnSessions(_sessionsCache);
  if (normalized.changed) _sessionsCache = normalized.items;
  return [..._sessionsCache].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createOrGetVnSession(characterId: string): VnSession {
  const normalized = normalizeVnSessions(_sessionsCache);
  if (normalized.changed) {
    _sessionsCache = normalized.items;
    persistVnSessionsSnapshot(normalized.items);
  }
  const existing = _sessionsCache.find((s) => s.characterId === characterId);
  if (existing) return existing;

  const session: VnSession = {
    id: generateId("vn_sess"),
    characterId,
    updatedAt: new Date().toISOString(),
    chapters: [],
    activeChapterIndex: -1,
  };
  _sessionsCache.unshift(session);
  vnDb.sessions.put(session).catch(() => undefined);
  return session;
}

export function loadVnMessages(sessionId: string): VnMessage[] {
  return _messagesCache
    .filter((m) => m.sessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function loadVnMessagesForChapter(sessionId: string, chapterIndex: number): VnMessage[] {
  return _messagesCache
    .filter((m) => m.sessionId === sessionId && m.chapterIndex === chapterIndex)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function pushVnMessage(
  input: Omit<VnMessage, "id" | "createdAt">
): VnMessage {
  const message: VnMessage = {
    ...input,
    id: generateId("vn_msg"),
    createdAt: new Date().toISOString(),
  };
  _messagesCache.push(message);
  vnDb.messages.put(message).catch(() => undefined);

  const preview = message.rawContent.replace(/\s+/g, " ").trim().slice(0, 64);
  updateVnSession(message.sessionId, {
    lastMessageId: message.id,
    lastMessagePreview: preview,
    updatedAt: message.createdAt,
  });

  return message;
}

export function deleteVnMessage(messageId: string): void {
  _messagesCache = _messagesCache.filter((m) => m.id !== messageId);
  vnDb.messages.delete(messageId).catch(() => undefined);
}

export function deleteVnMessagesFrom(sessionId: string, messageId: string): void {
  const msg = _messagesCache.find((m) => m.id === messageId);
  if (!msg) return;
  const idsToDelete = _messagesCache
    .filter((m) => m.sessionId === sessionId && m.createdAt >= msg.createdAt)
    .map((m) => m.id);
  _messagesCache = _messagesCache.filter((m) => !idsToDelete.includes(m.id));
  vnDb.messages.bulkDelete(idsToDelete).catch(() => undefined);
}

// ── 漫卷配音（frameAudio）占用统计与清理 ──
// 每帧配音以 base64 data URL 直接存在消息的 frameAudio 里（VnFrameAudio.audioDataUrl），
// 合成过一次就跟着那条消息常驻，不会自动回收。统计必须游标逐条扫：单条音频动辄
// 数百 KB，把整张消息表再 toArray() 一份进内存会让重度用户进存储页即 OOM。

/** 帧配音是否早于清理截止线。无时间戳按最旧算，语义与存储空间其它类别一致。 */
function frameAudioBeforeCutoff(iso: string | undefined, cutoff: number): boolean {
  if (cutoff === Number.POSITIVE_INFINITY) return true;
  if (!iso) return true;
  const parsed = Date.parse(iso);
  return !Number.isFinite(parsed) || parsed < cutoff;
}

/** 统计漫卷配音的总占用与帧数（只读，不改数据）。 */
export async function scanVnFrameAudio(): Promise<{ bytes: number; count: number }> {
  let bytes = 0;
  let count = 0;
  await vnDb.messages.each((message) => {
    const audio = message.frameAudio;
    if (!audio) return;
    for (const item of Object.values(audio)) {
      if (!item?.audioDataUrl) continue;
      bytes += estimateValueBytes(item.audioDataUrl);
      count += 1;
    }
  }).catch(() => undefined);
  return { bytes, count };
}

/**
 * 清理漫卷配音：只摘掉超期的 frameAudio 字段，剧情正文、章节、总结与场景立绘
 * 一律保留；需要时重新点该帧的喇叭即可再次合成（会重新消耗 TTS 额度）。
 * 时间基准用音频自身的 updatedAt（合成时间），缺失时退回消息 createdAt。
 */
export async function clearVnFrameAudio(
  options: { keepDays?: number } = {},
): Promise<{ cleared: number; freedBytes: number }> {
  const keepDays = options.keepDays;
  // 无有效天数 = 全部清理（与 storage-space 的 cutoffMs 同义）
  const cutoff = !keepDays || keepDays <= 0
    ? Number.POSITIVE_INFINITY
    : Date.now() - keepDays * 24 * 60 * 60 * 1000;
  // 先确保内存缓存已水合：否则水合快照可能晚于这次写库，把刚删掉的配音又覆盖回缓存
  await hydrateVnStorage();
  let cleared = 0;
  let freedBytes = 0;
  const updates: VnMessage[] = [];

  await vnDb.messages.each((message) => {
    if (!message.frameAudio) return;
    const kept: Record<number, VnFrameAudio> = {};
    let removed = 0;
    let removedBytes = 0;
    for (const [key, item] of Object.entries(message.frameAudio)) {
      const stamp = item?.updatedAt || message.createdAt;
      if (frameAudioBeforeCutoff(stamp, cutoff)) {
        removed += 1;
        if (item?.audioDataUrl) removedBytes += estimateValueBytes(item.audioDataUrl);
        continue;
      }
      kept[Number(key)] = item;
    }
    if (removed === 0) return;

    const next: VnMessage = { ...message };
    if (Object.keys(kept).length > 0) next.frameAudio = kept;
    else delete next.frameAudio;

    // 同步内存缓存：漫卷读的是 _messagesCache，只写 Dexie 会出现「清完又回来」
    const cacheIdx = _messagesCache.findIndex((m) => m.id === message.id);
    if (cacheIdx !== -1) _messagesCache[cacheIdx] = next;

    updates.push(next);
    cleared += removed;
    freedBytes += removedBytes;
  }).catch(() => undefined);

  if (updates.length > 0) await vnDb.messages.bulkPut(updates).catch(() => undefined);
  return { cleared, freedBytes };
}

export function editVnMessage(messageId: string, newRawContent: string): void {
  const idx = _messagesCache.findIndex((m) => m.id === messageId);
  if (idx === -1) return;
  _messagesCache[idx] = {
    ..._messagesCache[idx],
    rawContent: newRawContent,
  };
  vnDb.messages.put(_messagesCache[idx]).catch(() => undefined);
}

export function updateVnMessageFrameAudio(
  messageId: string,
  frameIndex: number,
  audio: VnFrameAudio,
): VnMessage | null {
  const idx = _messagesCache.findIndex((m) => m.id === messageId);
  if (idx === -1) return null;
  const frameAudio = {
    ..._messagesCache[idx].frameAudio,
    [frameIndex]: audio,
  };
  _messagesCache[idx] = {
    ..._messagesCache[idx],
    frameAudio,
  };
  vnDb.messages.put(_messagesCache[idx]).catch(() => undefined);
  return _messagesCache[idx];
}

function updateVnSession(sessionId: string, updates: Partial<VnSession>): VnSession | null {
  const idx = _sessionsCache.findIndex((s) => s.id === sessionId);
  if (idx === -1) return null;
  const next: VnSession = {
    ..._sessionsCache[idx],
    ...updates,
    updatedAt: updates.updatedAt || new Date().toISOString(),
  };
  _sessionsCache[idx] = next;
  vnDb.sessions.put(next).catch(() => undefined);
  return next;
}

export function saveVnLayoutPrefs(sessionId: string, prefs: VnLayoutPrefs): void {
  updateVnSession(sessionId, { layoutPrefs: prefs });
}

export function updateChapterBeats(sessionId: string, chapterIndex: number, beats: VnBeat[]): void {
  const session = _sessionsCache.find((s) => s.id === sessionId);
  if (!session) return;
  const chapters = [...session.chapters];
  if (!chapters[chapterIndex]) return;
  chapters[chapterIndex] = { ...chapters[chapterIndex], beats };
  updateVnSession(sessionId, { chapters });
}

export function setActiveBeatIndex(sessionId: string, chapterIndex: number, beatIndex: number): void {
  const session = _sessionsCache.find((s) => s.id === sessionId);
  if (!session) return;
  const chapters = [...session.chapters];
  if (!chapters[chapterIndex]) return;
  chapters[chapterIndex] = { ...chapters[chapterIndex], activeBeatIndex: beatIndex };
  updateVnSession(sessionId, { chapters });
}

export function formatBeatsForPrompt(chapter: VnChapterMeta): { beatsList: string; currentBeat: string } {
  const beats = chapter.beats;
  if (!beats || beats.length === 0) return { beatsList: "", currentBeat: "" };
  const activeIdx = chapter.activeBeatIndex ?? 0;
  const lines = beats.map((b, i) => {
    const marker = i < activeIdx ? "✓" : i === activeIdx ? "→" : " ";
    return `${marker} ${i + 1}. ${b.title}`;
  });
  const current = beats[activeIdx];
  const currentText = current
    ? `${current.title}${current.description ? `：${current.description}` : ""}`
    : "";
  return { beatsList: lines.join("\n"), currentBeat: currentText };
}

export function startNewChapter(
  sessionId: string,
  title: string,
  subtitle?: string
): VnChapterMeta | null {
  const session = _sessionsCache.find((s) => s.id === sessionId);
  if (!session) return null;

  const index = session.chapters.length;
  const chapter: VnChapterMeta = {
    id: generateId("vn_ch"),
    index,
    title,
    subtitle,
    startMessageId: "",
    archived: false,
  };

  const updatedChapters = [...session.chapters, chapter];
  updateVnSession(sessionId, {
    chapters: updatedChapters,
    activeChapterIndex: index,
  });

  return chapter;
}

export function archiveChapter(sessionId: string, chapterIndex: number): void {
  const session = _sessionsCache.find((s) => s.id === sessionId);
  if (!session) return;

  const chapters = [...session.chapters];
  const ch = chapters[chapterIndex];
  if (!ch) return;

  // Find last message in this chapter
  const chapterMessages = loadVnMessagesForChapter(sessionId, chapterIndex);
  const lastMsg = chapterMessages[chapterMessages.length - 1];

  chapters[chapterIndex] = {
    ...ch,
    archived: true,
    endMessageId: lastMsg?.id,
  };

  updateVnSession(sessionId, { chapters });
}

export function updateChapterSummary(
  sessionId: string,
  chapterIndex: number,
  summary: string
): void {
  const session = _sessionsCache.find((s) => s.id === sessionId);
  if (!session) return;

  const chapters = [...session.chapters];
  const ch = chapters[chapterIndex];
  if (!ch) return;

  chapters[chapterIndex] = {
    ...ch,
    summaryContent: summary,
    summaryTimestamp: new Date().toISOString(),
  };

  updateVnSession(sessionId, { chapters });
}

/** 清除章节已生成的总结记忆（summaryContent/summaryTimestamp），不影响章节与聊天记录。
 *  用于清理脏总结：清除后该章节的投影条目从短期记忆消失，需要时可重新生成。 */
export function clearChapterSummary(
  sessionId: string,
  chapterIndex: number
): void {
  const session = _sessionsCache.find((s) => s.id === sessionId);
  if (!session) return;

  const chapters = [...session.chapters];
  const ch = chapters[chapterIndex];
  if (!ch) return;

  const { summaryContent: _summaryContent, summaryTimestamp: _summaryTimestamp, ...rest } = ch;
  chapters[chapterIndex] = rest;

  updateVnSession(sessionId, { chapters });
}

export function updateChapterStartMessageId(
  sessionId: string,
  chapterIndex: number,
  messageId: string
): void {
  const session = _sessionsCache.find((s) => s.id === sessionId);
  if (!session) return;

  const chapters = [...session.chapters];
  const ch = chapters[chapterIndex];
  if (!ch || ch.startMessageId) return;

  chapters[chapterIndex] = { ...ch, startMessageId: messageId };
  updateVnSession(sessionId, { chapters });
}

// ── 无主剧情：会话行丢失后残留在 messages 表里的消息 ──
// 会话行一旦被误删，这些消息还带着已不存在的 sessionId：漫卷按当前会话 id 查不到，
// 表现就是星空页空白、没有对白。下面两个函数先把它们找出来，再合并回该角色的会话
// （重写 sessionId、chapterIndex 整体后移接在现有章节之后，正文一个字不动）。

export type VnOrphanMessageGroup = {
  sessionId: string;
  messageCount: number;
  chapterCount: number;
  firstAt: string;
  lastAt: string;
  audioFrames: number;
};

function vnChapterTitle(index: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  const n = index + 1;
  if (n <= 10) return `第${digits[n]}章`;
  if (n < 20) return `第十${digits[n - 10]}章`;
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `第${digits[tens]}十${ones ? digits[ones] : ""}章`;
}

/** 列出「有消息但没有对应会话行」的 sessionId 分组（只读，不改数据）。 */
export async function listOrphanVnMessageGroups(): Promise<VnOrphanMessageGroup[]> {
  await hydrateVnStorage();
  const known = new Set(_sessionsCache.map((s) => s.id));
  const bySession = new Map<string, VnMessage[]>();
  for (const message of _messagesCache) {
    if (known.has(message.sessionId)) continue;
    const list = bySession.get(message.sessionId);
    if (list) list.push(message);
    else bySession.set(message.sessionId, [message]);
  }

  const groups: VnOrphanMessageGroup[] = [];
  for (const [sessionId, messages] of bySession) {
    messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    let audioFrames = 0;
    for (const message of messages) {
      if (!message.frameAudio) continue;
      for (const item of Object.values(message.frameAudio)) {
        if (item?.audioDataUrl) audioFrames += 1;
      }
    }
    groups.push({
      sessionId,
      messageCount: messages.length,
      chapterCount: new Set(messages.map((m) => m.chapterIndex)).size,
      firstAt: messages[0]?.createdAt ?? "",
      lastAt: messages[messages.length - 1]?.createdAt ?? "",
      audioFrames,
    });
  }
  return groups.sort((a, b) => b.messageCount - a.messageCount);
}

/**
 * 把一组无主消息合并回指定角色的会话。只改每条消息的 sessionId 与 chapterIndex，
 * 正文、选项、轮次总结、配音全部原样保留；章节骨架按 chapterIndex 重建，
 * 标题退回「第N章」（原标题与章节总结存在已丢失的会话行里，无法找回）。
 */
export async function restoreOrphanVnMessages(
  sessionId: string,
  characterId: string,
): Promise<{ chapters: number; messages: number } | null> {
  await hydrateVnStorage();
  const orphans = _messagesCache
    .filter((m) => m.sessionId === sessionId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (orphans.length === 0) return null;

  const session = createOrGetVnSession(characterId);
  const distinct = Array.from(new Set(orphans.map((m) => m.chapterIndex))).sort((a, b) => a - b);
  // 整体后移，接在现有章节之后，避免与当前会话已有章节的 index 撞车
  const offset = session.chapters.length - distinct[0];

  const rewritten: VnMessage[] = [];
  for (const message of orphans) {
    const next: VnMessage = {
      ...message,
      sessionId: session.id,
      chapterIndex: message.chapterIndex + offset,
    };
    const idx = _messagesCache.findIndex((m) => m.id === message.id);
    if (idx !== -1) _messagesCache[idx] = next;
    rewritten.push(next);
  }

  const chapters = [...session.chapters];
  const lastNewIndex = distinct[distinct.length - 1] + offset;
  for (const oldIndex of distinct) {
    const newIndex = oldIndex + offset;
    if (chapters[newIndex]) continue;
    chapters[newIndex] = {
      id: generateId("vn_ch"),
      index: newIndex,
      title: vnChapterTitle(newIndex),
      startMessageId: "",
      // 除最后一章外一律标为已归档，与正常流程一致（否则章节页无法新建下一章）
      archived: newIndex < lastNewIndex,
    };
  }
  for (const chapter of chapters) {
    if (chapter.startMessageId) continue;
    const first = rewritten.find((m) => m.chapterIndex === chapter.index);
    if (first) chapter.startMessageId = first.id;
  }

  updateVnSession(session.id, { chapters, activeChapterIndex: Math.max(0, chapters.length - 1) });
  await vnDb.messages.bulkPut(rewritten).catch(() => undefined);
  return { chapters: distinct.length, messages: rewritten.length };
}

export type VnProjectionEntry = {
  id: string;
  timestamp: string;
  content: string;
};

function compactText(text: string, maxLen = 160): string {
  const plain = text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  return plain.length > maxLen ? `${plain.slice(0, maxLen)}...` : plain;
}

export function loadVnProjectionEntries(
  characterId: string,
  options?: { afterTimestamp?: string }
): VnProjectionEntry[] {
  const session = _sessionsCache.find((s) => s.characterId === characterId);
  if (!session) return [];

  const projections: VnProjectionEntry[] = [];

  for (const chapter of session.chapters) {
    // 未归档章节的滚动总结同样投影：漫卷每 N 轮自动总结会把章节总结写入
    // summaryContent，无需等归档即可进入统一时间线参与短期/长期记忆
    if (!chapter.summaryContent) continue;
    const ts = chapter.summaryTimestamp || session.updatedAt;
    if (options?.afterTimestamp && ts <= options.afterTimestamp) continue;

    const snippet = compactText(chapter.summaryContent, 500);
    if (!snippet) continue;

    const formattedTs = formatChatTimestamp(ts);
    projections.push({
      id: `vn_projection_${chapter.id}`,
      timestamp: ts,
      content: `[事件 ${formattedTs}] ${snippet}`,
    });
  }

  // 每轮消息的 roundSummary 直接投影：漫卷生成时模型输出的 <summary> 存进
  // VnMessage.roundSummary，随剧情实时进入短期记忆，无需归档或等阈值。
  const messageProjections = _messagesCache
    .filter((m) => m.sessionId === session.id && m.role === "assistant" && m.roundSummary)
    .map((m) => {
      const snippet = compactText(m.roundSummary!, 160);
      if (!snippet) return null;
      const formattedTs = formatChatTimestamp(m.createdAt);
      return {
        id: `vn_round_${m.id}`,
        timestamp: m.createdAt,
        content: `[事件 ${formattedTs}] ${snippet}`,
      } as VnProjectionEntry;
    })
    .filter((p): p is VnProjectionEntry => Boolean(p))
    .filter((p) => !options?.afterTimestamp || p.timestamp > options.afterTimestamp);
  projections.push(...messageProjections);

  return projections;
}

// ── Global VN Config (key-value in IndexedDB) ──

let _configCache: Record<string, string> = {};
let _configHydrated = false;

async function hydrateConfig(): Promise<void> {
  if (_configHydrated) return;
  try {
    const rows = await vnDb.config.toArray();
    for (const r of rows) _configCache[r.key] = r.value;
  } catch { /* table may not exist yet */ }
  _configHydrated = true;
}

// Call during app init (alongside hydrateVnStorage)
hydrateVnStorage().then(() => hydrateConfig());

export function loadVnConfig(key: string): string {
  return _configCache[key] || "";
}

export function saveVnConfig(key: string, value: string): void {
  if (value) {
    _configCache[key] = value;
    vnDb.config.put({ key, value }).catch(() => undefined);
  } else {
    delete _configCache[key];
    vnDb.config.delete(key).catch(() => undefined);
  }
}
