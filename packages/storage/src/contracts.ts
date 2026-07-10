export type AppId = "runos" | "wanoku-navi";

export type StorageMode = "local" | "memory" | "blocked" | "async-pending";

export type SaveFailureReason =
  | "serialize-failed"
  | "read-failed"
  | "write-failed"
  | "corrupt-data"
  | "corrupt-lock"
  | "quota-exceeded"
  | "blocked"
  | "validation-failed"
  | "storage-unavailable"
  | "unknown";

export type SaveResult<Key extends string = string> =
  | {
      status: "success";
      mode: "local";
      key: Key;
      bytes: number;
    }
  | {
      status: "memory";
      mode: "memory";
      key: Key;
      bytes?: number;
      reason: "storage-unavailable" | "write-failed" | "memory-only";
    }
  | {
      status: "blocked";
      mode: "blocked";
      key: Key;
      blockedKeys: readonly Key[];
      reason: "corrupt-lock";
      corruptBackup?: CorruptBackupInfo<Key>;
    }
  | {
      status: "failed";
      mode: Exclude<StorageMode, "blocked" | "async-pending">;
      key: Key;
      reason: SaveFailureReason;
      bytes?: number;
      error?: unknown;
    }
  | {
      status: "asyncAccepted";
      mode: "async-pending";
      key: Key;
      bytes?: number;
      provider: "window.storage" | "future-indexeddb";
    };

export type CorruptArchiveStatus = "archived" | "archive-failed" | "memory-only";

export type CorruptBackupInfo<Key extends string = string> = {
  app: AppId;
  sourceKey: Key;
  backupKey: string;
  timestamp: number;
  detectedAtIso: string;
  reason: "json-parse-failed" | "required-shape-missing" | "read-failed" | "unknown";
  archiveStatus: CorruptArchiveStatus;
  bytes?: number;
  rawValueAvailable: boolean;
  exportFileName?: string;
};

export type BackupKind = "normal-json" | "corrupt-raw";

export type BackupManifest<Key extends string = string> = {
  app: AppId;
  kind: BackupKind;
  createdAtIso: string;
  fileName: string;
  source: "localStorage" | "memory" | "indexedDB-future";
  keys: readonly Key[];
  formatVersion: string;
  includesCorruptRaw: boolean;
  notes?: readonly string[];
};

export const RUNOS_PRIMARY_STORAGE_KEY = "meridian.v1" as const;

export type RunosPrimaryStorageKey = typeof RUNOS_PRIMARY_STORAGE_KEY;
export type RunosCorruptStorageKey = `${RunosPrimaryStorageKey}.corrupt.${number}`;
export type RunosStorageKey = RunosPrimaryStorageKey | RunosCorruptStorageKey;

export type RunosStorageContract = {
  app: "runos";
  primaryKey: RunosPrimaryStorageKey;
  corruptKeyPattern: `${RunosPrimaryStorageKey}.corrupt.<timestamp>`;
  lockScope: "app";
  normalBackupFilePattern: "runos-backup-YYYY-MM-DD.json";
  corruptBackupFilePattern: "runos-corrupt-<detectedAt>.txt";
};

export const RUNOS_STORAGE_CONTRACT: RunosStorageContract = {
  app: "runos",
  primaryKey: RUNOS_PRIMARY_STORAGE_KEY,
  corruptKeyPattern: "meridian.v1.corrupt.<timestamp>",
  lockScope: "app",
  normalBackupFilePattern: "runos-backup-YYYY-MM-DD.json",
  corruptBackupFilePattern: "runos-corrupt-<detectedAt>.txt"
};

export const WANOKU_STORAGE_KEYS = [
  "spots",
  "logs",
  "signals",
  "settings",
  "ai",
  "userCatches",
  "forecasts",
  "tuningHistory",
  "observations",
  "fieldDecisions",
  "reviewReports",
  "tripPlans",
  "officialSignals",
  "officialFetchHistory",
  "noFishingNotes",
  "sourceRep",
  "extIntel",
  "lastAutoTuneAt"
] as const;

export type WanokuStorageKey = (typeof WANOKU_STORAGE_KEYS)[number];
export type WanokuCorruptStorageKey = `${WanokuStorageKey}.corrupt.${number}`;
export type WanokuAnyStorageKey = WanokuStorageKey | WanokuCorruptStorageKey;

export type WanokuBlockedKeyState<Key extends WanokuStorageKey = WanokuStorageKey> = {
  lockScope: "key";
  blockedKeys: readonly Key[];
  corruptBackups: readonly CorruptBackupInfo<Key>[];
};

export type WanokuStorageContract = {
  app: "wanoku-navi";
  keys: typeof WANOKU_STORAGE_KEYS;
  corruptKeyPattern: "<元キー>.corrupt.<timestamp>";
  lockScope: "key";
  normalBackupFileName: "wanoku-v27.json";
  corruptBackupFilePattern: "wanoku-corrupt-<元キー>-<detectedAt>.txt";
  multiKeyWritesAreTransactional: false;
};

export const WANOKU_STORAGE_CONTRACT: WanokuStorageContract = {
  app: "wanoku-navi",
  keys: WANOKU_STORAGE_KEYS,
  corruptKeyPattern: "<元キー>.corrupt.<timestamp>",
  lockScope: "key",
  normalBackupFileName: "wanoku-v27.json",
  corruptBackupFilePattern: "wanoku-corrupt-<元キー>-<detectedAt>.txt",
  multiKeyWritesAreTransactional: false
};

export function createCorruptBackupKey<Key extends string>(sourceKey: Key, timestamp: number): `${Key}.corrupt.${number}` {
  assertSafeTimestamp(timestamp);
  return `${sourceKey}.corrupt.${timestamp}` as `${Key}.corrupt.${number}`;
}

export function createRunosCorruptBackupKey(timestamp: number): RunosCorruptStorageKey {
  return createCorruptBackupKey(RUNOS_PRIMARY_STORAGE_KEY, timestamp);
}

export function createWanokuCorruptBackupKey<Key extends WanokuStorageKey>(
  sourceKey: Key,
  timestamp: number
): `${Key}.corrupt.${number}` {
  assertWanokuStorageKey(sourceKey);
  return createCorruptBackupKey(sourceKey, timestamp);
}

export function isRunosCorruptBackupKey(key: string): key is RunosCorruptStorageKey {
  return /^meridian\.v1\.corrupt\.\d+$/.test(key);
}

export function isWanokuStorageKey(key: string): key is WanokuStorageKey {
  return (WANOKU_STORAGE_KEYS as readonly string[]).includes(key);
}

export function isWanokuCorruptBackupKey(key: string): key is WanokuCorruptStorageKey {
  return /^(spots|logs|signals|settings|ai|userCatches|forecasts|tuningHistory|observations|fieldDecisions|reviewReports|tripPlans|officialSignals|officialFetchHistory|noFishingNotes|sourceRep|extIntel|lastAutoTuneAt)\.corrupt\.\d+$/.test(
    key
  );
}

function assertWanokuStorageKey(key: string): asserts key is WanokuStorageKey {
  if (!isWanokuStorageKey(key)) {
    throw new RangeError(`Unknown wanoku storage key: ${key}`);
  }
}

function assertSafeTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new RangeError("timestamp must be a non-negative safe integer.");
  }
}
