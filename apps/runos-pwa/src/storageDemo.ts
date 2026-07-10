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
export const RUNOS_DEMO_CORRUPT_JSON = "{broken-runos-demo-json";
export const RUNOS_DEMO_BACKUP_TYPE = "runos-pwa-demo-settings" as const;
export const RUNOS_DEMO_BACKUP_SCHEMA_VERSION = "runos-pwa-demo-settings-v1";

export type RunosDemoSettings = {
  app: "runos-pwa-demo";
  distanceUnit: "km";
  paceFormat: "min/km";
  updatedAtIso: string;
};

export function createRunosStorageAdapter(storage?: LocalStorageLike): LocalStorageAdapter<typeof RUNOS_DEMO_SETTINGS_KEY> {
  return new LocalStorageAdapter<typeof RUNOS_DEMO_SETTINGS_KEY>({
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

export function writeRunosDemoCorruptJson(storage: LocalStorageLike): void {
  storage.setItem(RUNOS_DEMO_SETTINGS_KEY, RUNOS_DEMO_CORRUPT_JSON);
}

export function createRunosDemoBackup(settings: RunosDemoSettings, createdAt = new Date().toISOString()): BackupJson<
  RunosDemoSettings,
  typeof RUNOS_DEMO_BACKUP_TYPE
> {
  return createBackupJson({
    backupType: RUNOS_DEMO_BACKUP_TYPE,
    appId: "runos",
    schemaVersion: RUNOS_DEMO_BACKUP_SCHEMA_VERSION,
    createdAt,
    data: settings
  });
}

export function createRunosDemoBackupText(settings: RunosDemoSettings, createdAt?: string): string {
  return stringifyBackupJson(createRunosDemoBackup(settings, createdAt));
}

export function parseRunosDemoBackupText(
  text: string
): ParseBackupJsonResult<RunosDemoSettings, typeof RUNOS_DEMO_BACKUP_TYPE> {
  return parseBackupJson({
    text,
    expectedBackupType: RUNOS_DEMO_BACKUP_TYPE,
    expectedAppId: "runos",
    expectedSchemaVersion: RUNOS_DEMO_BACKUP_SCHEMA_VERSION,
    validateData: isRunosDemoSettings
  });
}

export function restoreRunosDemoBackupText(
  adapter: LocalStorageAdapter<typeof RUNOS_DEMO_SETTINGS_KEY>,
  text: string
): SaveResult<typeof RUNOS_DEMO_SETTINGS_KEY> | { status: "rejected"; reason: string; message: string } {
  const parsed = parseRunosDemoBackupText(text);
  if (!parsed.ok) {
    return {
      status: "rejected",
      reason: parsed.reason,
      message: parsed.message
    };
  }

  adapter.allowOverwrite(RUNOS_DEMO_SETTINGS_KEY);
  return adapter.saveJson(RUNOS_DEMO_SETTINGS_KEY, parsed.backup.data);
}

export function createRunosDemoBackupFileName(now = new Date()): string {
  return `runos-pwa-demo-backup-${now.toISOString().slice(0, 10)}.json`;
}

export function describeRunosSaveResult(result: SaveResult<typeof RUNOS_DEMO_SETTINGS_KEY>): string {
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
  result: LoadJsonResult<typeof RUNOS_DEMO_SETTINGS_KEY, RunosDemoSettings>,
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

export function describeRunosRestoreResult(
  result: SaveResult<typeof RUNOS_DEMO_SETTINGS_KEY> | { status: "rejected"; reason: string; message: string }
): string {
  if (result.status === "rejected") {
    return `復元拒否: reason=${result.reason}, message=${result.message}`;
  }

  return `復元結果: ${describeRunosSaveResult(result)}`;
}
