// Resilient IndexedDB open.
//
// Several stores open their database at a fixed version constant. The data
// backup/restore engine, however, bumps a database's version whenever it needs to
// create object stores. After restoring into a fresh browser the stored version
// can end up HIGHER than the code's constant, and `indexedDB.open(name, fixed)`
// then fails with "An attempt was made to open a database using a lower version
// than the existing version." — breaking that whole store.
//
// openIndexedDbAtLeast() opens normally at minVersion (so first-time creation and
// real upgrades run the onUpgrade callback), and only if that throws a VersionError
// (the stored DB is already newer) does it reopen without a version, adopting the
// existing schema — whose stores were already created by the restore.
//
// ── 升级阻塞加固（用户实报：升版本后重开网页，记忆看着全没了）─────────────
// 两处针对「数据还在、但读不出来」的修复：
//
// 1) 升级被旧连接阻塞时不再立即 reject。
//    IndexedDB 的 open 请求遇到其它连接（另一个标签页、常驻的 PWA 窗口）占用时，
//    只会触发 onblocked 并继续等待对方让位，请求本身仍然有效。旧实现在 onblocked
//    里直接 reject，上层 .catch(() => null) 把「打不开」当成「没有数据」，
//    于是所有记忆读出来都是空数组——界面上看起来就像被清空了，其实一条没少。
//    现在：只通知 + 日志，并留一个超时兜底（超时抛 IdbBlockedError，明确说明原因）。
//
// 2) 新打开的连接挂上 onversionchange 自动关闭。
//    否则本页自己持有的旧连接会把后续的版本升级一直卡住（自己阻塞自己）。

export type IdbBlockedHandler = (dbName: string) => void;

/** 升级被阻塞时默认等多久才放弃（毫秒）。等的时候旧页面若关闭，升级会立刻完成。 */
const DEFAULT_BLOCKED_TIMEOUT_MS = 8000;

let globalBlockedHandler: IdbBlockedHandler | null = null;

/**
 * 注册全局的「升级被阻塞」回调（UI 可据此提示用户关闭其它已打开的页面）。
 * 传 null 取消注册。
 */
export function setIdbBlockedHandler(handler: IdbBlockedHandler | null): void {
  globalBlockedHandler = handler;
}

/** 数据库升级被其它连接阻塞而超时。调用方应把它和「数据不存在」区分对待。 */
export class IdbBlockedError extends Error {
  readonly dbName: string;
  constructor(dbName: string) {
    super(`数据库「${dbName}」的版本升级被其它已打开的页面占用而阻塞。请关闭其它标签页或已安装的应用窗口后重试。`);
    this.name = "IdbBlockedError";
    this.dbName = dbName;
  }
}

export function openIndexedDbAtLeast(
  name: string,
  minVersion: number,
  onUpgrade: (db: IDBDatabase, oldVersion: number, tx: IDBTransaction | null) => void,
  options?: { onBlocked?: IdbBlockedHandler; blockedTimeoutMs?: number },
): Promise<IDBDatabase> {
  const blockedHandler = options?.onBlocked ?? globalBlockedHandler ?? null;
  const blockedTimeoutMs = options?.blockedTimeoutMs ?? DEFAULT_BLOCKED_TIMEOUT_MS;

  const openAt = (version?: number): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try {
        req = version ? indexedDB.open(name, version) : indexedDB.open(name);
      } catch (err) {
        reject(err);
        return;
      }

      let blockedTimer: ReturnType<typeof setTimeout> | null = null;
      const clearBlockedTimer = () => {
        if (blockedTimer !== null) {
          clearTimeout(blockedTimer);
          blockedTimer = null;
        }
      };

      req.onupgradeneeded = (event) => onUpgrade(req.result, event.oldVersion, req.transaction);

      req.onsuccess = () => {
        clearBlockedTimer();
        const db = req.result;
        // 让位：别的页面要升级这个库时，本连接自动关闭，避免互相阻塞。
        // 各调用方都是「一次操作一个连接、用完立刻 close」，这里关闭的窗口很短。
        db.onversionchange = () => {
          try {
            db.close();
          } catch {
            /* 已经关掉了就算了 */
          }
        };
        resolve(db);
      };

      req.onerror = () => {
        clearBlockedTimer();
        reject(req.error);
      };

      req.onblocked = () => {
        // 关键：这里绝不 reject。请求仍在等待旧连接让位，随后仍可能成功。
        // 提前失败会让上层把「暂时打不开」误判成「没有数据」。
        try {
          blockedHandler?.(name);
        } catch {
          /* 回调异常不影响打开流程 */
        }
        console.warn(`[idb-open] 数据库「${name}」升级被阻塞：有其它页面或 PWA 窗口仍占用它。正在等待其让位…`);
        if (blockedTimer === null) {
          blockedTimer = setTimeout(() => {
            blockedTimer = null;
            console.warn(`[idb-open] 数据库「${name}」等待 ${blockedTimeoutMs}ms 仍未让位，放弃本次打开。`);
            reject(new IdbBlockedError(name));
          }, blockedTimeoutMs);
        }
      };
    });

  return openAt(minVersion).catch((err: unknown) => {
    // The stored DB is already at a higher version (e.g. inflated by a restore) —
    // reopen at whatever version exists; its stores are already there.
    if (err instanceof DOMException && err.name === "VersionError") {
      return openAt(undefined);
    }
    throw err;
  });
}
