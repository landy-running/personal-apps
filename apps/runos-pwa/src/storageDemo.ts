import {
  createLightweightRunLog,
  isLightweightRunLogArray,
  type CreateLightweightRunLogInput,
  type LightweightRunLog
} from "@personal/runos-core";
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

export const RUNOS_DEMO_SETTINGS_KEY = "runos-pwa.demo.settings" as const;
export const RUNOS_DEMO_RUN_LOGS_KEY = "runos-pwa.demo.runLogs" as const;
export const RUNOS_DEMO_CORRUPT_JSON = "{broken-runos-demo-json";
export const RUNOS_DEMO_BACKUP_TYPE = "runos-pwa-demo-data" as const;
export const RUNOS_DEMO_BACKUP_SCHEMA_VERSION = "runos-pwa-demo-data-v1";

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

export function createRunosStorageAdapter(storage?: LocalStorageLike): LocalStorageAdapter<RunosDemoStorageKey> {
  return new LocalStorageAdapter<RunosDemoStorageKey>({
    app: "runos",
    storage
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

export function loadRunosDemoBackupData(adapter: LocalStorageAdapter<RunosDemoStorageKey>): RunosDemoBackupData {
  const settingsResult = adapter.loadJson(RUNOS_DEMO_SETTINGS_KEY, isRunosDemoSettings);

  return {
    settings: settingsResult.status === "success" ? settingsResult.value : createRunosDemoSettings(),
    runLogs: getRunosRunLogsOrEmpty(adapter)
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

function createRunosRunLogId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
