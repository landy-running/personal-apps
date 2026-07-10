import {
  createLightweightCatchLog,
  isLightweightCatchLogArray,
  type CreateLightweightCatchLogInput,
  type LightweightCatchLog
} from "@personal/wanoku-core";
import {
  type BackupJson,
  IndexedDbJsonAdapter,
  LocalStorageAdapter,
  type IndexedDbFactoryLike,
  type LoadJsonResult,
  type LocalStorageLike,
  type ParseBackupJsonResult,
  type SaveResult,
  type StorageMode,
  createBackupJson,
  parseBackupJson,
  stringifyBackupJson
} from "@personal/storage";

export const WANOKU_DEMO_SETTINGS_KEY = "wanoku-pwa.demo.settings" as const;
export const WANOKU_DEMO_CATCH_LOGS_KEY = "wanoku-pwa.demo.catchLogs" as const;
export const WANOKU_DEMO_CORRUPT_JSON = "{broken-wanoku-demo-json";
export const WANOKU_DEMO_BACKUP_TYPE = "wanoku-pwa-demo-data" as const;
export const WANOKU_DEMO_BACKUP_SCHEMA_VERSION = "wanoku-pwa-demo-data-v1";
export const WANOKU_INDEXEDDB_DB_NAME = "wanoku-pwa" as const;
export const WANOKU_INDEXEDDB_VERSION = 1;
export const WANOKU_INDEXEDDB_STORE_NAME = "demo-key-value" as const;
export const WANOKU_INDEXEDDB_BACKUP_TYPE = "wanoku-pwa-indexeddb-demo-data" as const;
export const WANOKU_INDEXEDDB_BACKUP_SCHEMA_VERSION = "wanoku-pwa-indexeddb-demo-data-v1";

export type WanokuDemoStorageKey = typeof WANOKU_DEMO_SETTINGS_KEY | typeof WANOKU_DEMO_CATCH_LOGS_KEY;

export type WanokuDemoSettings = {
  app: "wanoku-pwa-demo";
  defaultFish: "シーバス";
  area: "東京湾奥";
  updatedAtIso: string;
};

export type WanokuDemoBackupData = {
  settings: WanokuDemoSettings;
  catchLogs: LightweightCatchLog[];
};

export type WanokuLogStorageMode = "localStorage" | "indexedDB" | "dual-write";
export type WanokuLogStorageTarget = "localStorage" | "indexedDB";
export type WanokuLogStorageModeSaveResult = {
  status: "success" | "partial" | "failed";
  mode: WanokuLogStorageMode;
  canonicalSource: WanokuLogStorageTarget;
  savedAtIso: string;
  catchLogCount: number;
  localStorageResult?: SaveResult<WanokuDemoStorageKey>;
  indexedDbResult?: SaveResult<WanokuDemoStorageKey>;
  failedTargets: readonly WanokuLogStorageTarget[];
};

export type WanokuIndexedDbDemoSaveResult = {
  dbName: typeof WANOKU_INDEXEDDB_DB_NAME;
  storeName: typeof WANOKU_INDEXEDDB_STORE_NAME;
  savedAtIso: string;
  settingsResult: SaveResult<WanokuDemoStorageKey>;
  catchLogsResult: SaveResult<WanokuDemoStorageKey>;
  catchLogCount: number;
};

export type WanokuIndexedDbDemoLoadResult = {
  dbName: typeof WANOKU_INDEXEDDB_DB_NAME;
  storeName: typeof WANOKU_INDEXEDDB_STORE_NAME;
  loadedAtIso: string;
  settingsResult: LoadJsonResult<WanokuDemoStorageKey, WanokuDemoSettings>;
  catchLogsResult: LoadJsonResult<WanokuDemoStorageKey, LightweightCatchLog[]>;
  catchLogCount: number;
};

export type WanokuIndexedDbDemoBackupExportResult =
  | {
      status: "exported";
      backupText: string;
      fileName: string;
      backup: BackupJson<WanokuDemoBackupData, typeof WANOKU_INDEXEDDB_BACKUP_TYPE>;
      catchLogCount: number;
    }
  | {
      status: "rejected";
      reason: string;
      message: string;
    };

export type WanokuIndexedDbDemoRestoreResult =
  | {
      status: "restored";
      settingsResult: SaveResult<WanokuDemoStorageKey>;
      catchLogsResult: SaveResult<WanokuDemoStorageKey>;
      catchLogCount: number;
    }
  | {
      status: "rejected";
      reason: string;
      message: string;
    };

export type WanokuDemoRestoreResult =
  | {
      status: "restored";
      settingsResult: SaveResult<WanokuDemoStorageKey>;
      catchLogsResult: SaveResult<WanokuDemoStorageKey>;
    }
  | {
      status: "rejected";
      reason: string;
      message: string;
    };

type WanokuIndexedDbAdapterLike = Pick<
  IndexedDbJsonAdapter<WanokuDemoStorageKey>,
  "mode" | "loadJson" | "saveJson"
> & {
  allowOverwrite?: (keys?: WanokuDemoStorageKey | ReadonlyArray<WanokuDemoStorageKey>) => void;
};

export function createWanokuStorageAdapter(storage?: LocalStorageLike): LocalStorageAdapter<WanokuDemoStorageKey> {
  return new LocalStorageAdapter<WanokuDemoStorageKey>({
    app: "wanoku-navi",
    storage
  });
}

export function createWanokuIndexedDbAdapter(indexedDB?: IndexedDbFactoryLike): IndexedDbJsonAdapter<WanokuDemoStorageKey> {
  return new IndexedDbJsonAdapter<WanokuDemoStorageKey>({
    app: "wanoku-navi",
    dbName: WANOKU_INDEXEDDB_DB_NAME,
    version: WANOKU_INDEXEDDB_VERSION,
    storeName: WANOKU_INDEXEDDB_STORE_NAME,
    indexedDB
  });
}

export function createWanokuDemoSettings(now = new Date()): WanokuDemoSettings {
  return {
    app: "wanoku-pwa-demo",
    defaultFish: "シーバス",
    area: "東京湾奥",
    updatedAtIso: now.toISOString()
  };
}

export function isWanokuDemoSettings(value: unknown): value is WanokuDemoSettings {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.app === "wanoku-pwa-demo" && record.defaultFish === "シーバス" && record.area === "東京湾奥" && typeof record.updatedAtIso === "string";
}

export function isWanokuDemoBackupData(value: unknown): value is WanokuDemoBackupData {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isWanokuDemoSettings(record.settings) && isLightweightCatchLogArray(record.catchLogs);
}

export function writeWanokuDemoCorruptJson(storage: LocalStorageLike): void {
  storage.setItem(WANOKU_DEMO_SETTINGS_KEY, WANOKU_DEMO_CORRUPT_JSON);
}

export function loadWanokuCatchLogs(
  adapter: LocalStorageAdapter<WanokuDemoStorageKey>
): LoadJsonResult<WanokuDemoStorageKey, LightweightCatchLog[]> {
  return adapter.loadJson(WANOKU_DEMO_CATCH_LOGS_KEY, isLightweightCatchLogArray);
}

export function getWanokuCatchLogsOrEmpty(adapter: LocalStorageAdapter<WanokuDemoStorageKey>): LightweightCatchLog[] {
  const result = loadWanokuCatchLogs(adapter);
  return result.status === "success" ? result.value : [];
}

export function saveWanokuCatchLogs(
  adapter: LocalStorageAdapter<WanokuDemoStorageKey>,
  logs: LightweightCatchLog[]
): SaveResult<WanokuDemoStorageKey> {
  return adapter.saveJson(WANOKU_DEMO_CATCH_LOGS_KEY, logs);
}

export async function loadWanokuCatchLogsFromIndexedDb(
  adapter: WanokuIndexedDbAdapterLike
): Promise<LoadJsonResult<WanokuDemoStorageKey, LightweightCatchLog[]>> {
  return adapter.loadJson(WANOKU_DEMO_CATCH_LOGS_KEY, isLightweightCatchLogArray);
}

export async function getWanokuCatchLogsForMode(
  mode: WanokuLogStorageMode,
  localAdapter: LocalStorageAdapter<WanokuDemoStorageKey>,
  indexedDbAdapter: WanokuIndexedDbAdapterLike
): Promise<LightweightCatchLog[]> {
  if (getWanokuCanonicalSource(mode) === "localStorage") {
    return getWanokuCatchLogsOrEmpty(localAdapter);
  }

  const result = await loadWanokuCatchLogsFromIndexedDb(indexedDbAdapter);
  return result.status === "success" ? result.value : [];
}

export async function saveWanokuCatchLogsForMode(
  mode: WanokuLogStorageMode,
  localAdapter: LocalStorageAdapter<WanokuDemoStorageKey>,
  indexedDbAdapter: WanokuIndexedDbAdapterLike,
  logs: LightweightCatchLog[],
  now = new Date()
): Promise<WanokuLogStorageModeSaveResult> {
  const canonicalSource = getWanokuCanonicalSource(mode);
  const localStorageResult =
    mode === "localStorage" || mode === "dual-write" ? saveWanokuCatchLogs(localAdapter, logs) : undefined;
  const indexedDbResult =
    mode === "indexedDB" || mode === "dual-write"
      ? await indexedDbAdapter.saveJson(WANOKU_DEMO_CATCH_LOGS_KEY, logs)
      : undefined;
  const failedTargets: WanokuLogStorageTarget[] = [];

  if (localStorageResult && !isDurableSaveSuccess(localStorageResult)) {
    failedTargets.push("localStorage");
  }
  if (indexedDbResult && !isDurableSaveSuccess(indexedDbResult)) {
    failedTargets.push("indexedDB");
  }

  return {
    status: failedTargets.length === 0 ? "success" : failedTargets.length === getWanokuTargetCount(mode) ? "failed" : "partial",
    mode,
    canonicalSource,
    savedAtIso: now.toISOString(),
    catchLogCount: logs.length,
    localStorageResult,
    indexedDbResult,
    failedTargets
  };
}

export function addWanokuCatchLog(
  adapter: LocalStorageAdapter<WanokuDemoStorageKey>,
  input: Omit<CreateLightweightCatchLogInput, "id"> & { id?: string }
):
  | {
      ok: true;
      log: LightweightCatchLog;
      saveResult: SaveResult<WanokuDemoStorageKey>;
    }
  | {
      ok: false;
      message: string;
    } {
  try {
    const log = createLightweightCatchLog({
      ...input,
      id: input.id ?? createWanokuCatchLogId()
    });
    const existing = getWanokuCatchLogsOrEmpty(adapter);
    const saveResult = saveWanokuCatchLogs(adapter, [log, ...existing]);

    return {
      ok: true,
      log,
      saveResult
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "釣果ログの作成に失敗しました。"
    };
  }
}

export async function addWanokuCatchLogForMode(
  mode: WanokuLogStorageMode,
  localAdapter: LocalStorageAdapter<WanokuDemoStorageKey>,
  indexedDbAdapter: WanokuIndexedDbAdapterLike,
  input: Omit<CreateLightweightCatchLogInput, "id"> & { id?: string },
  now = new Date()
): Promise<
  | {
      ok: true;
      log: LightweightCatchLog;
      saveResult: WanokuLogStorageModeSaveResult;
    }
  | {
      ok: false;
      message: string;
    }
> {
  try {
    const log = createLightweightCatchLog({
      ...input,
      id: input.id ?? createWanokuCatchLogId()
    });
    const existing = await getWanokuCatchLogsForMode(mode, localAdapter, indexedDbAdapter);
    const saveResult = await saveWanokuCatchLogsForMode(mode, localAdapter, indexedDbAdapter, [log, ...existing], now);

    return {
      ok: true,
      log,
      saveResult
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "釣果ログの作成に失敗しました。"
    };
  }
}

export function deleteWanokuCatchLog(
  adapter: LocalStorageAdapter<WanokuDemoStorageKey>,
  id: string
): SaveResult<WanokuDemoStorageKey> {
  const existing = getWanokuCatchLogsOrEmpty(adapter);
  return saveWanokuCatchLogs(
    adapter,
    existing.filter((log) => log.id !== id)
  );
}

export async function deleteWanokuCatchLogForMode(
  mode: WanokuLogStorageMode,
  localAdapter: LocalStorageAdapter<WanokuDemoStorageKey>,
  indexedDbAdapter: WanokuIndexedDbAdapterLike,
  id: string,
  now = new Date()
): Promise<WanokuLogStorageModeSaveResult> {
  const existing = await getWanokuCatchLogsForMode(mode, localAdapter, indexedDbAdapter);
  return saveWanokuCatchLogsForMode(
    mode,
    localAdapter,
    indexedDbAdapter,
    existing.filter((log) => log.id !== id),
    now
  );
}

export function createWanokuDemoBackup(
  data: WanokuDemoBackupData,
  createdAt = new Date().toISOString()
): BackupJson<WanokuDemoBackupData, typeof WANOKU_DEMO_BACKUP_TYPE> {
  return createBackupJson({
    backupType: WANOKU_DEMO_BACKUP_TYPE,
    appId: "wanoku-navi",
    schemaVersion: WANOKU_DEMO_BACKUP_SCHEMA_VERSION,
    createdAt,
    data
  });
}

export function createWanokuDemoBackupText(data: WanokuDemoBackupData, createdAt?: string): string {
  return stringifyBackupJson(createWanokuDemoBackup(data, createdAt));
}

export function createWanokuIndexedDbDemoBackup(
  data: WanokuDemoBackupData,
  createdAt = new Date().toISOString()
): BackupJson<WanokuDemoBackupData, typeof WANOKU_INDEXEDDB_BACKUP_TYPE> {
  return createBackupJson({
    backupType: WANOKU_INDEXEDDB_BACKUP_TYPE,
    appId: "wanoku-navi",
    schemaVersion: WANOKU_INDEXEDDB_BACKUP_SCHEMA_VERSION,
    createdAt,
    data
  });
}

export function createWanokuIndexedDbDemoBackupText(data: WanokuDemoBackupData, createdAt?: string): string {
  return stringifyBackupJson(createWanokuIndexedDbDemoBackup(data, createdAt));
}

export function parseWanokuDemoBackupText(
  text: string
): ParseBackupJsonResult<WanokuDemoBackupData, typeof WANOKU_DEMO_BACKUP_TYPE> {
  return parseBackupJson({
    text,
    expectedBackupType: WANOKU_DEMO_BACKUP_TYPE,
    expectedAppId: "wanoku-navi",
    expectedSchemaVersion: WANOKU_DEMO_BACKUP_SCHEMA_VERSION,
    validateData: isWanokuDemoBackupData
  });
}

export function parseWanokuIndexedDbDemoBackupText(
  text: string
): ParseBackupJsonResult<WanokuDemoBackupData, typeof WANOKU_INDEXEDDB_BACKUP_TYPE> {
  return parseBackupJson({
    text,
    expectedBackupType: WANOKU_INDEXEDDB_BACKUP_TYPE,
    expectedAppId: "wanoku-navi",
    expectedSchemaVersion: WANOKU_INDEXEDDB_BACKUP_SCHEMA_VERSION,
    validateData: isWanokuDemoBackupData
  });
}

export function loadWanokuDemoBackupData(adapter: LocalStorageAdapter<WanokuDemoStorageKey>): WanokuDemoBackupData {
  const settingsResult = adapter.loadJson(WANOKU_DEMO_SETTINGS_KEY, isWanokuDemoSettings);

  return {
    settings: settingsResult.status === "success" ? settingsResult.value : createWanokuDemoSettings(),
    catchLogs: getWanokuCatchLogsOrEmpty(adapter)
  };
}

export async function exportWanokuIndexedDbDemoBackupText(
  indexedDbAdapter: WanokuIndexedDbAdapterLike,
  now = new Date()
): Promise<WanokuIndexedDbDemoBackupExportResult> {
  const loaded = await loadWanokuDemoFromIndexedDb(indexedDbAdapter, now);

  if (loaded.settingsResult.status !== "success") {
    return {
      status: "rejected",
      reason: `settings-${loaded.settingsResult.status}`,
      message: `IndexedDB settingsをバックアップできません: ${describeWanokuIndexedDbLoadLine(loaded.settingsResult)}`
    };
  }

  if (loaded.catchLogsResult.status !== "success") {
    return {
      status: "rejected",
      reason: `catchLogs-${loaded.catchLogsResult.status}`,
      message: `IndexedDB catchLogsをバックアップできません: ${describeWanokuIndexedDbLoadLine(loaded.catchLogsResult)}`
    };
  }

  const data = {
    settings: loaded.settingsResult.value,
    catchLogs: loaded.catchLogsResult.value
  };
  const backup = createWanokuIndexedDbDemoBackup(data, now.toISOString());

  return {
    status: "exported",
    backup,
    backupText: stringifyBackupJson(backup),
    fileName: createWanokuIndexedDbDemoBackupFileName(now),
    catchLogCount: data.catchLogs.length
  };
}

export async function saveWanokuDemoToIndexedDb(
  indexedDbAdapter: WanokuIndexedDbAdapterLike,
  localAdapter: LocalStorageAdapter<WanokuDemoStorageKey>,
  now = new Date()
): Promise<WanokuIndexedDbDemoSaveResult> {
  const data = loadWanokuDemoBackupData(localAdapter);
  const settingsResult = await indexedDbAdapter.saveJson(WANOKU_DEMO_SETTINGS_KEY, data.settings);
  const catchLogsResult = await indexedDbAdapter.saveJson(WANOKU_DEMO_CATCH_LOGS_KEY, data.catchLogs);

  return {
    dbName: WANOKU_INDEXEDDB_DB_NAME,
    storeName: WANOKU_INDEXEDDB_STORE_NAME,
    savedAtIso: now.toISOString(),
    settingsResult,
    catchLogsResult,
    catchLogCount: data.catchLogs.length
  };
}

export async function loadWanokuDemoFromIndexedDb(
  indexedDbAdapter: WanokuIndexedDbAdapterLike,
  now = new Date()
): Promise<WanokuIndexedDbDemoLoadResult> {
  const settingsResult = await indexedDbAdapter.loadJson(WANOKU_DEMO_SETTINGS_KEY, isWanokuDemoSettings);
  const catchLogsResult = await indexedDbAdapter.loadJson(WANOKU_DEMO_CATCH_LOGS_KEY, isLightweightCatchLogArray);

  return {
    dbName: WANOKU_INDEXEDDB_DB_NAME,
    storeName: WANOKU_INDEXEDDB_STORE_NAME,
    loadedAtIso: now.toISOString(),
    settingsResult,
    catchLogsResult,
    catchLogCount: catchLogsResult.status === "success" ? catchLogsResult.value.length : 0
  };
}

export async function restoreWanokuIndexedDbDemoBackupText(
  indexedDbAdapter: WanokuIndexedDbAdapterLike,
  text: string
): Promise<WanokuIndexedDbDemoRestoreResult> {
  const parsed = parseWanokuIndexedDbDemoBackupText(text);
  if (!parsed.ok) {
    return {
      status: "rejected",
      reason: parsed.reason,
      message: parsed.message
    };
  }

  indexedDbAdapter.allowOverwrite?.([WANOKU_DEMO_SETTINGS_KEY, WANOKU_DEMO_CATCH_LOGS_KEY]);
  const settingsResult = await indexedDbAdapter.saveJson(WANOKU_DEMO_SETTINGS_KEY, parsed.backup.data.settings);
  const catchLogsResult = await indexedDbAdapter.saveJson(WANOKU_DEMO_CATCH_LOGS_KEY, parsed.backup.data.catchLogs);

  return {
    status: "restored",
    settingsResult,
    catchLogsResult,
    catchLogCount: parsed.backup.data.catchLogs.length
  };
}

export function restoreWanokuDemoBackupText(adapter: LocalStorageAdapter<WanokuDemoStorageKey>, text: string): WanokuDemoRestoreResult {
  const parsed = parseWanokuDemoBackupText(text);
  if (!parsed.ok) {
    return {
      status: "rejected",
      reason: parsed.reason,
      message: parsed.message
    };
  }

  adapter.allowOverwrite([WANOKU_DEMO_SETTINGS_KEY, WANOKU_DEMO_CATCH_LOGS_KEY]);
  return {
    status: "restored",
    settingsResult: adapter.saveJson(WANOKU_DEMO_SETTINGS_KEY, parsed.backup.data.settings),
    catchLogsResult: adapter.saveJson(WANOKU_DEMO_CATCH_LOGS_KEY, parsed.backup.data.catchLogs)
  };
}

export function createWanokuDemoBackupFileName(now = new Date()): string {
  return `wanoku-pwa-demo-backup-${now.toISOString().slice(0, 10)}.json`;
}

export function createWanokuIndexedDbDemoBackupFileName(now = new Date()): string {
  return `wanoku-pwa-idb-demo-backup-${now.toISOString().slice(0, 10)}.json`;
}

export function describeWanokuSaveResult(result: SaveResult<WanokuDemoStorageKey>): string {
  switch (result.status) {
    case "success":
      return `保存成功: key=${result.key}, mode=${result.mode}, size=${result.bytes} bytes`;
    case "memory":
      return `一時保存: key=${result.key}, mode=${result.mode}, reason=${result.reason}, size=${result.bytes ?? "unknown"} bytes`;
    case "blocked":
      return `保存停止: key=${result.key}, reason=${result.reason}, corruptBackup=${result.corruptBackup?.backupKey ?? "none"}`;
    case "failed":
      return `保存失敗: key=${result.key}, mode=${result.mode}, reason=${result.reason}, size=${result.bytes ?? "unknown"} bytes`;
    case "asyncAccepted":
      return `非同期保存受付: key=${result.key}, provider=${result.provider}, size=${result.bytes ?? "unknown"} bytes`;
  }
}

export function describeWanokuLoadResult(
  result: LoadJsonResult<WanokuDemoStorageKey, WanokuDemoSettings>,
  mode: StorageMode
): string {
  switch (result.status) {
    case "success":
      return `読込成功: key=${result.key}, mode=${result.mode}, adapterMode=${mode}, size=${result.bytes} bytes`;
    case "missing":
      return `未保存: key=${result.key}, mode=${result.mode}, adapterMode=${mode}`;
    case "corrupt":
      return `破損検知: key=${result.key}, backup=${result.corruptBackup.backupKey}, archive=${result.corruptBackup.archiveStatus}`;
    case "failed":
      return `読込失敗: key=${result.key}, mode=${result.mode}, reason=${result.reason}`;
  }
}

export function describeWanokuRestoreResult(result: WanokuDemoRestoreResult): string {
  if (result.status === "rejected") {
    return `復元拒否: reason=${result.reason}, message=${result.message}`;
  }

  return `復元結果:
settings: ${describeWanokuSaveResult(result.settingsResult)}
catchLogs: ${describeWanokuSaveResult(result.catchLogsResult)}`;
}

export function describeWanokuIndexedDbSaveResult(result: WanokuIndexedDbDemoSaveResult): string {
  return `IndexedDB保存結果:
保存先: IndexedDB db=${result.dbName}, store=${result.storeName}
最終保存時刻: ${result.savedAtIso}
件数: catchLogs=${result.catchLogCount}
settings: ${describeWanokuSaveResult(result.settingsResult)}
catchLogs: ${describeWanokuSaveResult(result.catchLogsResult)}`;
}

export function describeWanokuIndexedDbLoadResult(result: WanokuIndexedDbDemoLoadResult): string {
  return `IndexedDB読込結果:
保存先: IndexedDB db=${result.dbName}, store=${result.storeName}
最終読込時刻: ${result.loadedAtIso}
件数: catchLogs=${result.catchLogCount}
settings: ${describeWanokuIndexedDbLoadLine(result.settingsResult)}
catchLogs: ${describeWanokuIndexedDbLoadLine(result.catchLogsResult)}`;
}

export function describeWanokuIndexedDbBackupExportResult(result: WanokuIndexedDbDemoBackupExportResult): string {
  if (result.status === "rejected") {
    return `IndexedDBバックアップ書き出し不可: reason=${result.reason}, message=${result.message}`;
  }

  return `IndexedDBバックアップを書き出しました:
file=${result.fileName}
backupType=${result.backup.backupType}
schemaVersion=${result.backup.schemaVersion}
件数: catchLogs=${result.catchLogCount}`;
}

export function describeWanokuIndexedDbRestoreResult(result: WanokuIndexedDbDemoRestoreResult): string {
  if (result.status === "rejected") {
    return `IndexedDB復元拒否: reason=${result.reason}, message=${result.message}`;
  }

  return `IndexedDB復元結果:
件数: catchLogs=${result.catchLogCount}
settings: ${describeWanokuSaveResult(result.settingsResult)}
catchLogs: ${describeWanokuSaveResult(result.catchLogsResult)}`;
}

export function getWanokuCanonicalSource(mode: WanokuLogStorageMode): WanokuLogStorageTarget {
  return mode === "indexedDB" ? "indexedDB" : "localStorage";
}

export function describeWanokuLogStorageMode(mode: WanokuLogStorageMode): string {
  switch (mode) {
    case "localStorage":
      return "localStorage";
    case "indexedDB":
      return "IndexedDB";
    case "dual-write":
      return "dual-write（正本: localStorage）";
  }
}

export function describeWanokuLogStorageModeSaveResult(result: WanokuLogStorageModeSaveResult): string {
  const statusText =
    result.status === "success"
      ? "保存成功"
      : result.status === "partial"
        ? "一部保存失敗"
        : "保存失敗";
  const failedText = result.failedTargets.length > 0 ? result.failedTargets.join(", ") : "なし";
  const localText = result.localStorageResult ? describeWanokuSaveResult(result.localStorageResult) : "対象外";
  const indexedDbText = result.indexedDbResult ? describeWanokuSaveResult(result.indexedDbResult) : "対象外";

  return `軽量釣果ログ 保存結果:
状態: ${statusText}
保存先モード: ${describeWanokuLogStorageMode(result.mode)}
正本: ${result.canonicalSource}
最終保存時刻: ${result.savedAtIso}
件数: catchLogs=${result.catchLogCount}
失敗先: ${failedText}
localStorage: ${localText}
IndexedDB: ${indexedDbText}`;
}

function describeWanokuIndexedDbLoadLine<Value>(result: LoadJsonResult<WanokuDemoStorageKey, Value>): string {
  switch (result.status) {
    case "success":
      return `読込成功: key=${result.key}, mode=${result.mode}, size=${result.bytes} bytes`;
    case "missing":
      return `未保存: key=${result.key}, mode=${result.mode}`;
    case "corrupt":
      return `破損検知: key=${result.key}, backup=${result.corruptBackup.backupKey}, archive=${result.corruptBackup.archiveStatus}`;
    case "failed":
      return `読込失敗: key=${result.key}, mode=${result.mode}, reason=${result.reason}`;
  }
}

function isDurableSaveSuccess(result: SaveResult<WanokuDemoStorageKey>): boolean {
  return result.status === "success";
}

function getWanokuTargetCount(mode: WanokuLogStorageMode): number {
  return mode === "dual-write" ? 2 : 1;
}

function createWanokuCatchLogId(): string {
  return `catch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
