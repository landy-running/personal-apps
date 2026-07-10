import {
  createLightweightRunLog,
  isLightweightRunLogArray,
  type CreateLightweightRunLogInput,
  type LightweightRunLog
} from "@personal/runos-core";
import {
  type BackupJson,
  LocalStorageAdapter,
  IndexedDbJsonAdapter,
  type LoadJsonResult,
  type IndexedDbFactoryLike,
  type LocalStorageLike,
  type ParseBackupJsonResult,
  type SaveResult,
  type StorageMode,
  createBackupJson,
  parseBackupJson,
  stringifyBackupJson
} from "@personal/storage";

export const RUNOS_DEMO_SETTINGS_KEY = "runos-pwa.demo.settings" as const;
export const RUNOS_DEMO_RUN_LOGS_KEY = "runos-pwa.demo.runLogs" as const;
export const RUNOS_DEMO_CORRUPT_JSON = "{broken-runos-demo-json";
export const RUNOS_DEMO_BACKUP_TYPE = "runos-pwa-demo-data" as const;
export const RUNOS_DEMO_BACKUP_SCHEMA_VERSION = "runos-pwa-demo-data-v1";
export const RUNOS_INDEXEDDB_DB_NAME = "runos-pwa" as const;
export const RUNOS_INDEXEDDB_VERSION = 1;
export const RUNOS_INDEXEDDB_STORE_NAME = "demo-key-value" as const;
export const RUNOS_INDEXEDDB_BACKUP_TYPE = "runos-pwa-indexeddb-demo-data" as const;
export const RUNOS_INDEXEDDB_BACKUP_SCHEMA_VERSION = "runos-pwa-indexeddb-demo-data-v1";

export type RunosDemoStorageKey = typeof RUNOS_DEMO_SETTINGS_KEY | typeof RUNOS_DEMO_RUN_LOGS_KEY;

export type RunosDemoSettings = {
  app: "runos-pwa-demo";
  distanceUnit: "km";
  paceFormat: "min/km";
  updatedAtIso: string;
};

export type RunosDemoBackupData = {
  settings: RunosDemoSettings;
  runLogs: LightweightRunLog[];
};

export type RunosLogStorageMode = "localStorage" | "indexedDB" | "dual-write";
export type RunosLogStorageTarget = "localStorage" | "indexedDB";
export type RunosLogStorageModeSaveResult = {
  status: "success" | "partial" | "failed";
  mode: RunosLogStorageMode;
  canonicalSource: RunosLogStorageTarget;
  savedAtIso: string;
  runLogCount: number;
  localStorageResult?: SaveResult<RunosDemoStorageKey>;
  indexedDbResult?: SaveResult<RunosDemoStorageKey>;
  failedTargets: readonly RunosLogStorageTarget[];
};

export type RunosIndexedDbDemoSaveResult = {
  dbName: typeof RUNOS_INDEXEDDB_DB_NAME;
  storeName: typeof RUNOS_INDEXEDDB_STORE_NAME;
  savedAtIso: string;
  settingsResult: SaveResult<RunosDemoStorageKey>;
  runLogsResult: SaveResult<RunosDemoStorageKey>;
  runLogCount: number;
};

export type RunosIndexedDbDemoLoadResult = {
  dbName: typeof RUNOS_INDEXEDDB_DB_NAME;
  storeName: typeof RUNOS_INDEXEDDB_STORE_NAME;
  loadedAtIso: string;
  settingsResult: LoadJsonResult<RunosDemoStorageKey, RunosDemoSettings>;
  runLogsResult: LoadJsonResult<RunosDemoStorageKey, LightweightRunLog[]>;
  runLogCount: number;
};

export type RunosIndexedDbDemoBackupExportResult =
  | {
      status: "exported";
      backupText: string;
      fileName: string;
      backup: BackupJson<RunosDemoBackupData, typeof RUNOS_INDEXEDDB_BACKUP_TYPE>;
      runLogCount: number;
    }
  | {
      status: "rejected";
      reason: string;
      message: string;
    };

export type RunosIndexedDbDemoRestoreResult =
  | {
      status: "restored";
      settingsResult: SaveResult<RunosDemoStorageKey>;
      runLogsResult: SaveResult<RunosDemoStorageKey>;
      runLogCount: number;
    }
  | {
      status: "rejected";
      reason: string;
      message: string;
    };

export type RunosDemoRestoreResult =
  | {
      status: "restored";
      settingsResult: SaveResult<RunosDemoStorageKey>;
      runLogsResult: SaveResult<RunosDemoStorageKey>;
    }
  | {
      status: "rejected";
      reason: string;
      message: string;
    };

type RunosIndexedDbAdapterLike = Pick<
  IndexedDbJsonAdapter<RunosDemoStorageKey>,
  "mode" | "loadJson" | "saveJson"
> & {
  allowOverwrite?: (keys?: RunosDemoStorageKey | ReadonlyArray<RunosDemoStorageKey>) => void;
};

export function createRunosStorageAdapter(storage?: LocalStorageLike): LocalStorageAdapter<RunosDemoStorageKey> {
  return new LocalStorageAdapter<RunosDemoStorageKey>({
    app: "runos",
    storage
  });
}

export function createRunosIndexedDbAdapter(indexedDB?: IndexedDbFactoryLike): IndexedDbJsonAdapter<RunosDemoStorageKey> {
  return new IndexedDbJsonAdapter<RunosDemoStorageKey>({
    app: "runos",
    dbName: RUNOS_INDEXEDDB_DB_NAME,
    version: RUNOS_INDEXEDDB_VERSION,
    storeName: RUNOS_INDEXEDDB_STORE_NAME,
    indexedDB
  });
}

export function createRunosDemoSettings(now = new Date()): RunosDemoSettings {
  return {
    app: "runos-pwa-demo",
    distanceUnit: "km",
    paceFormat: "min/km",
    updatedAtIso: now.toISOString()
  };
}

export function isRunosDemoSettings(value: unknown): value is RunosDemoSettings {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.app === "runos-pwa-demo" && record.distanceUnit === "km" && record.paceFormat === "min/km" && typeof record.updatedAtIso === "string";
}

export function isRunosDemoBackupData(value: unknown): value is RunosDemoBackupData {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return isRunosDemoSettings(record.settings) && isLightweightRunLogArray(record.runLogs);
}

export function writeRunosDemoCorruptJson(storage: LocalStorageLike): void {
  storage.setItem(RUNOS_DEMO_SETTINGS_KEY, RUNOS_DEMO_CORRUPT_JSON);
}

export function loadRunosRunLogs(
  adapter: LocalStorageAdapter<RunosDemoStorageKey>
): LoadJsonResult<RunosDemoStorageKey, LightweightRunLog[]> {
  return adapter.loadJson(RUNOS_DEMO_RUN_LOGS_KEY, isLightweightRunLogArray);
}

export function getRunosRunLogsOrEmpty(adapter: LocalStorageAdapter<RunosDemoStorageKey>): LightweightRunLog[] {
  const result = loadRunosRunLogs(adapter);
  return result.status === "success" ? result.value : [];
}

export function saveRunosRunLogs(
  adapter: LocalStorageAdapter<RunosDemoStorageKey>,
  logs: LightweightRunLog[]
): SaveResult<RunosDemoStorageKey> {
  return adapter.saveJson(RUNOS_DEMO_RUN_LOGS_KEY, logs);
}

export async function loadRunosRunLogsFromIndexedDb(
  adapter: RunosIndexedDbAdapterLike
): Promise<LoadJsonResult<RunosDemoStorageKey, LightweightRunLog[]>> {
  return adapter.loadJson(RUNOS_DEMO_RUN_LOGS_KEY, isLightweightRunLogArray);
}

export async function getRunosRunLogsForMode(
  mode: RunosLogStorageMode,
  localAdapter: LocalStorageAdapter<RunosDemoStorageKey>,
  indexedDbAdapter: RunosIndexedDbAdapterLike
): Promise<LightweightRunLog[]> {
  if (getRunosCanonicalSource(mode) === "localStorage") {
    return getRunosRunLogsOrEmpty(localAdapter);
  }

  const result = await loadRunosRunLogsFromIndexedDb(indexedDbAdapter);
  return result.status === "success" ? result.value : [];
}

export async function saveRunosRunLogsForMode(
  mode: RunosLogStorageMode,
  localAdapter: LocalStorageAdapter<RunosDemoStorageKey>,
  indexedDbAdapter: RunosIndexedDbAdapterLike,
  logs: LightweightRunLog[],
  now = new Date()
): Promise<RunosLogStorageModeSaveResult> {
  const canonicalSource = getRunosCanonicalSource(mode);
  const localStorageResult =
    mode === "localStorage" || mode === "dual-write" ? saveRunosRunLogs(localAdapter, logs) : undefined;
  const indexedDbResult =
    mode === "indexedDB" || mode === "dual-write"
      ? await indexedDbAdapter.saveJson(RUNOS_DEMO_RUN_LOGS_KEY, logs)
      : undefined;
  const failedTargets: RunosLogStorageTarget[] = [];

  if (localStorageResult && !isDurableSaveSuccess(localStorageResult)) {
    failedTargets.push("localStorage");
  }
  if (indexedDbResult && !isDurableSaveSuccess(indexedDbResult)) {
    failedTargets.push("indexedDB");
  }

  return {
    status: failedTargets.length === 0 ? "success" : failedTargets.length === getRunosTargetCount(mode) ? "failed" : "partial",
    mode,
    canonicalSource,
    savedAtIso: now.toISOString(),
    runLogCount: logs.length,
    localStorageResult,
    indexedDbResult,
    failedTargets
  };
}

export function addRunosRunLog(
  adapter: LocalStorageAdapter<RunosDemoStorageKey>,
  input: Omit<CreateLightweightRunLogInput, "id"> & { id?: string }
):
  | {
      ok: true;
      log: LightweightRunLog;
      saveResult: SaveResult<RunosDemoStorageKey>;
    }
  | {
      ok: false;
      message: string;
    } {
  try {
    const log = createLightweightRunLog({
      ...input,
      id: input.id ?? createRunosRunLogId()
    });
    const existing = getRunosRunLogsOrEmpty(adapter);
    const saveResult = saveRunosRunLogs(adapter, [log, ...existing]);

    return {
      ok: true,
      log,
      saveResult
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "ラン記録の作成に失敗しました。"
    };
  }
}

export async function addRunosRunLogForMode(
  mode: RunosLogStorageMode,
  localAdapter: LocalStorageAdapter<RunosDemoStorageKey>,
  indexedDbAdapter: RunosIndexedDbAdapterLike,
  input: Omit<CreateLightweightRunLogInput, "id"> & { id?: string },
  now = new Date()
): Promise<
  | {
      ok: true;
      log: LightweightRunLog;
      saveResult: RunosLogStorageModeSaveResult;
    }
  | {
      ok: false;
      message: string;
    }
> {
  try {
    const log = createLightweightRunLog({
      ...input,
      id: input.id ?? createRunosRunLogId()
    });
    const existing = await getRunosRunLogsForMode(mode, localAdapter, indexedDbAdapter);
    const saveResult = await saveRunosRunLogsForMode(mode, localAdapter, indexedDbAdapter, [log, ...existing], now);

    return {
      ok: true,
      log,
      saveResult
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "ラン記録の作成に失敗しました。"
    };
  }
}

export function deleteRunosRunLog(
  adapter: LocalStorageAdapter<RunosDemoStorageKey>,
  id: string
): SaveResult<RunosDemoStorageKey> {
  const existing = getRunosRunLogsOrEmpty(adapter);
  return saveRunosRunLogs(
    adapter,
    existing.filter((log) => log.id !== id)
  );
}

export async function deleteRunosRunLogForMode(
  mode: RunosLogStorageMode,
  localAdapter: LocalStorageAdapter<RunosDemoStorageKey>,
  indexedDbAdapter: RunosIndexedDbAdapterLike,
  id: string,
  now = new Date()
): Promise<RunosLogStorageModeSaveResult> {
  const existing = await getRunosRunLogsForMode(mode, localAdapter, indexedDbAdapter);
  return saveRunosRunLogsForMode(
    mode,
    localAdapter,
    indexedDbAdapter,
    existing.filter((log) => log.id !== id),
    now
  );
}

export function createRunosDemoBackup(
  data: RunosDemoBackupData,
  createdAt = new Date().toISOString()
): BackupJson<RunosDemoBackupData, typeof RUNOS_DEMO_BACKUP_TYPE> {
  return createBackupJson({
    backupType: RUNOS_DEMO_BACKUP_TYPE,
    appId: "runos",
    schemaVersion: RUNOS_DEMO_BACKUP_SCHEMA_VERSION,
    createdAt,
    data
  });
}

export function createRunosDemoBackupText(data: RunosDemoBackupData, createdAt?: string): string {
  return stringifyBackupJson(createRunosDemoBackup(data, createdAt));
}

export function createRunosIndexedDbDemoBackup(
  data: RunosDemoBackupData,
  createdAt = new Date().toISOString()
): BackupJson<RunosDemoBackupData, typeof RUNOS_INDEXEDDB_BACKUP_TYPE> {
  return createBackupJson({
    backupType: RUNOS_INDEXEDDB_BACKUP_TYPE,
    appId: "runos",
    schemaVersion: RUNOS_INDEXEDDB_BACKUP_SCHEMA_VERSION,
    createdAt,
    data
  });
}

export function createRunosIndexedDbDemoBackupText(data: RunosDemoBackupData, createdAt?: string): string {
  return stringifyBackupJson(createRunosIndexedDbDemoBackup(data, createdAt));
}

export function parseRunosDemoBackupText(
  text: string
): ParseBackupJsonResult<RunosDemoBackupData, typeof RUNOS_DEMO_BACKUP_TYPE> {
  return parseBackupJson({
    text,
    expectedBackupType: RUNOS_DEMO_BACKUP_TYPE,
    expectedAppId: "runos",
    expectedSchemaVersion: RUNOS_DEMO_BACKUP_SCHEMA_VERSION,
    validateData: isRunosDemoBackupData
  });
}

export function parseRunosIndexedDbDemoBackupText(
  text: string
): ParseBackupJsonResult<RunosDemoBackupData, typeof RUNOS_INDEXEDDB_BACKUP_TYPE> {
  return parseBackupJson({
    text,
    expectedBackupType: RUNOS_INDEXEDDB_BACKUP_TYPE,
    expectedAppId: "runos",
    expectedSchemaVersion: RUNOS_INDEXEDDB_BACKUP_SCHEMA_VERSION,
    validateData: isRunosDemoBackupData
  });
}

export function loadRunosDemoBackupData(adapter: LocalStorageAdapter<RunosDemoStorageKey>): RunosDemoBackupData {
  const settingsResult = adapter.loadJson(RUNOS_DEMO_SETTINGS_KEY, isRunosDemoSettings);

  return {
    settings: settingsResult.status === "success" ? settingsResult.value : createRunosDemoSettings(),
    runLogs: getRunosRunLogsOrEmpty(adapter)
  };
}

export async function exportRunosIndexedDbDemoBackupText(
  indexedDbAdapter: RunosIndexedDbAdapterLike,
  now = new Date()
): Promise<RunosIndexedDbDemoBackupExportResult> {
  const loaded = await loadRunosDemoFromIndexedDb(indexedDbAdapter, now);

  if (loaded.settingsResult.status !== "success") {
    return {
      status: "rejected",
      reason: `settings-${loaded.settingsResult.status}`,
      message: `IndexedDB settingsをバックアップできません: ${describeRunosIndexedDbLoadLine(loaded.settingsResult)}`
    };
  }

  if (loaded.runLogsResult.status !== "success") {
    return {
      status: "rejected",
      reason: `runLogs-${loaded.runLogsResult.status}`,
      message: `IndexedDB runLogsをバックアップできません: ${describeRunosIndexedDbLoadLine(loaded.runLogsResult)}`
    };
  }

  const data = {
    settings: loaded.settingsResult.value,
    runLogs: loaded.runLogsResult.value
  };
  const backup = createRunosIndexedDbDemoBackup(data, now.toISOString());

  return {
    status: "exported",
    backup,
    backupText: stringifyBackupJson(backup),
    fileName: createRunosIndexedDbDemoBackupFileName(now),
    runLogCount: data.runLogs.length
  };
}

export async function saveRunosDemoToIndexedDb(
  indexedDbAdapter: RunosIndexedDbAdapterLike,
  localAdapter: LocalStorageAdapter<RunosDemoStorageKey>,
  now = new Date()
): Promise<RunosIndexedDbDemoSaveResult> {
  const data = loadRunosDemoBackupData(localAdapter);
  const settingsResult = await indexedDbAdapter.saveJson(RUNOS_DEMO_SETTINGS_KEY, data.settings);
  const runLogsResult = await indexedDbAdapter.saveJson(RUNOS_DEMO_RUN_LOGS_KEY, data.runLogs);

  return {
    dbName: RUNOS_INDEXEDDB_DB_NAME,
    storeName: RUNOS_INDEXEDDB_STORE_NAME,
    savedAtIso: now.toISOString(),
    settingsResult,
    runLogsResult,
    runLogCount: data.runLogs.length
  };
}

export async function loadRunosDemoFromIndexedDb(
  indexedDbAdapter: RunosIndexedDbAdapterLike,
  now = new Date()
): Promise<RunosIndexedDbDemoLoadResult> {
  const settingsResult = await indexedDbAdapter.loadJson(RUNOS_DEMO_SETTINGS_KEY, isRunosDemoSettings);
  const runLogsResult = await indexedDbAdapter.loadJson(RUNOS_DEMO_RUN_LOGS_KEY, isLightweightRunLogArray);

  return {
    dbName: RUNOS_INDEXEDDB_DB_NAME,
    storeName: RUNOS_INDEXEDDB_STORE_NAME,
    loadedAtIso: now.toISOString(),
    settingsResult,
    runLogsResult,
    runLogCount: runLogsResult.status === "success" ? runLogsResult.value.length : 0
  };
}

export async function restoreRunosIndexedDbDemoBackupText(
  indexedDbAdapter: RunosIndexedDbAdapterLike,
  text: string
): Promise<RunosIndexedDbDemoRestoreResult> {
  const parsed = parseRunosIndexedDbDemoBackupText(text);
  if (!parsed.ok) {
    return {
      status: "rejected",
      reason: parsed.reason,
      message: parsed.message
    };
  }

  indexedDbAdapter.allowOverwrite?.([RUNOS_DEMO_SETTINGS_KEY, RUNOS_DEMO_RUN_LOGS_KEY]);
  const settingsResult = await indexedDbAdapter.saveJson(RUNOS_DEMO_SETTINGS_KEY, parsed.backup.data.settings);
  const runLogsResult = await indexedDbAdapter.saveJson(RUNOS_DEMO_RUN_LOGS_KEY, parsed.backup.data.runLogs);

  return {
    status: "restored",
    settingsResult,
    runLogsResult,
    runLogCount: parsed.backup.data.runLogs.length
  };
}

export function restoreRunosDemoBackupText(adapter: LocalStorageAdapter<RunosDemoStorageKey>, text: string): RunosDemoRestoreResult {
  const parsed = parseRunosDemoBackupText(text);
  if (!parsed.ok) {
    return {
      status: "rejected",
      reason: parsed.reason,
      message: parsed.message
    };
  }

  adapter.allowOverwrite([RUNOS_DEMO_SETTINGS_KEY, RUNOS_DEMO_RUN_LOGS_KEY]);
  return {
    status: "restored",
    settingsResult: adapter.saveJson(RUNOS_DEMO_SETTINGS_KEY, parsed.backup.data.settings),
    runLogsResult: adapter.saveJson(RUNOS_DEMO_RUN_LOGS_KEY, parsed.backup.data.runLogs)
  };
}

export function createRunosDemoBackupFileName(now = new Date()): string {
  return `runos-pwa-demo-backup-${now.toISOString().slice(0, 10)}.json`;
}

export function createRunosIndexedDbDemoBackupFileName(now = new Date()): string {
  return `runos-pwa-idb-demo-backup-${now.toISOString().slice(0, 10)}.json`;
}

export function describeRunosSaveResult(result: SaveResult<RunosDemoStorageKey>): string {
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

export function describeRunosLoadResult(
  result: LoadJsonResult<RunosDemoStorageKey, RunosDemoSettings>,
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

export function describeRunosRestoreResult(result: RunosDemoRestoreResult): string {
  if (result.status === "rejected") {
    return `復元拒否: reason=${result.reason}, message=${result.message}`;
  }

  return `復元結果:
settings: ${describeRunosSaveResult(result.settingsResult)}
runLogs: ${describeRunosSaveResult(result.runLogsResult)}`;
}

export function describeRunosIndexedDbSaveResult(result: RunosIndexedDbDemoSaveResult): string {
  return `IndexedDB保存結果:
保存先: IndexedDB db=${result.dbName}, store=${result.storeName}
最終保存時刻: ${result.savedAtIso}
件数: runLogs=${result.runLogCount}
settings: ${describeRunosSaveResult(result.settingsResult)}
runLogs: ${describeRunosSaveResult(result.runLogsResult)}`;
}

export function describeRunosIndexedDbLoadResult(result: RunosIndexedDbDemoLoadResult): string {
  return `IndexedDB読込結果:
保存先: IndexedDB db=${result.dbName}, store=${result.storeName}
最終読込時刻: ${result.loadedAtIso}
件数: runLogs=${result.runLogCount}
settings: ${describeRunosIndexedDbLoadLine(result.settingsResult)}
runLogs: ${describeRunosIndexedDbLoadLine(result.runLogsResult)}`;
}

export function describeRunosIndexedDbBackupExportResult(result: RunosIndexedDbDemoBackupExportResult): string {
  if (result.status === "rejected") {
    return `IndexedDBバックアップ書き出し不可: reason=${result.reason}, message=${result.message}`;
  }

  return `IndexedDBバックアップを書き出しました:
file=${result.fileName}
backupType=${result.backup.backupType}
schemaVersion=${result.backup.schemaVersion}
件数: runLogs=${result.runLogCount}`;
}

export function describeRunosIndexedDbRestoreResult(result: RunosIndexedDbDemoRestoreResult): string {
  if (result.status === "rejected") {
    return `IndexedDB復元拒否: reason=${result.reason}, message=${result.message}`;
  }

  return `IndexedDB復元結果:
件数: runLogs=${result.runLogCount}
settings: ${describeRunosSaveResult(result.settingsResult)}
runLogs: ${describeRunosSaveResult(result.runLogsResult)}`;
}

export function getRunosCanonicalSource(mode: RunosLogStorageMode): RunosLogStorageTarget {
  return mode === "indexedDB" ? "indexedDB" : "localStorage";
}

export function describeRunosLogStorageMode(mode: RunosLogStorageMode): string {
  switch (mode) {
    case "localStorage":
      return "localStorage";
    case "indexedDB":
      return "IndexedDB";
    case "dual-write":
      return "dual-write（正本: localStorage）";
  }
}

export function describeRunosLogStorageModeSaveResult(result: RunosLogStorageModeSaveResult): string {
  const statusText =
    result.status === "success"
      ? "保存成功"
      : result.status === "partial"
        ? "一部保存失敗"
        : "保存失敗";
  const failedText = result.failedTargets.length > 0 ? result.failedTargets.join(", ") : "なし";
  const localText = result.localStorageResult ? describeRunosSaveResult(result.localStorageResult) : "対象外";
  const indexedDbText = result.indexedDbResult ? describeRunosSaveResult(result.indexedDbResult) : "対象外";

  return `軽量ラン記録 保存結果:
状態: ${statusText}
保存先モード: ${describeRunosLogStorageMode(result.mode)}
正本: ${result.canonicalSource}
最終保存時刻: ${result.savedAtIso}
件数: runLogs=${result.runLogCount}
失敗先: ${failedText}
localStorage: ${localText}
IndexedDB: ${indexedDbText}`;
}

function describeRunosIndexedDbLoadLine<Value>(result: LoadJsonResult<RunosDemoStorageKey, Value>): string {
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

function isDurableSaveSuccess(result: SaveResult<RunosDemoStorageKey>): boolean {
  return result.status === "success";
}

function getRunosTargetCount(mode: RunosLogStorageMode): number {
  return mode === "dual-write" ? 2 : 1;
}

function createRunosRunLogId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
