import {
  createLightweightCatchLog,
  isLightweightCatchLogArray,
  type CreateLightweightCatchLogInput,
  type LightweightCatchLog
} from "@personal/wanoku-core";
import {
  type BackupJson,
  LocalStorageAdapter,
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

export function createWanokuStorageAdapter(storage?: LocalStorageLike): LocalStorageAdapter<WanokuDemoStorageKey> {
  return new LocalStorageAdapter<WanokuDemoStorageKey>({
    app: "wanoku-navi",
    storage
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

export function loadWanokuDemoBackupData(adapter: LocalStorageAdapter<WanokuDemoStorageKey>): WanokuDemoBackupData {
  const settingsResult = adapter.loadJson(WANOKU_DEMO_SETTINGS_KEY, isWanokuDemoSettings);

  return {
    settings: settingsResult.status === "success" ? settingsResult.value : createWanokuDemoSettings(),
    catchLogs: getWanokuCatchLogsOrEmpty(adapter)
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

function createWanokuCatchLogId(): string {
  return `catch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
