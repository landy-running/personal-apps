import {
  type AppId,
  type CorruptBackupInfo,
  type SaveResult,
  type StorageMode,
  createCorruptBackupKey
} from "./contracts";
import { type JsonStringifyResult, estimateUtf8Bytes, safeJsonStringify } from "./json";

export type LocalStorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
};

export type JsonValidator<T> = (value: unknown) => value is T;

export type LoadJsonResult<Key extends string, Value> =
  | {
      status: "success";
      mode: Exclude<StorageMode, "blocked" | "async-pending">;
      key: Key;
      value: Value;
      bytes: number;
    }
  | {
      status: "missing";
      mode: Exclude<StorageMode, "blocked" | "async-pending">;
      key: Key;
    }
  | {
      status: "corrupt";
      mode: "blocked";
      key: Key;
      rawValue: string;
      corruptBackup: CorruptBackupInfo<Key>;
      error?: unknown;
    }
  | {
      status: "failed";
      mode: Exclude<StorageMode, "blocked" | "async-pending">;
      key: Key;
      reason: "read-failed";
      error: unknown;
    };

export type ArchiveCorruptValueOptions<Key extends string> = {
  app: AppId;
  sourceKey: Key;
  rawValue: string;
  timestamp?: number;
  detectedAtIso?: string;
  reason: CorruptBackupInfo<Key>["reason"];
  storage?: LocalStorageLike;
  exportFileName?: string;
};

export type LocalStorageAdapterOptions = {
  app: AppId;
  storage?: LocalStorageLike;
  now?: () => number;
};

export class LocalStorageAdapter<Key extends string = string> {
  private readonly app: AppId;
  private readonly storage?: LocalStorageLike;
  private readonly now: () => number;
  private readonly memory = new Map<Key, string>();
  private readonly blockedKeys = new Map<Key, CorruptBackupInfo<Key>>();
  private currentMode: StorageMode;

  constructor(options: LocalStorageAdapterOptions) {
    this.app = options.app;
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.currentMode = options.storage ? "local" : "memory";
  }

  get mode(): StorageMode {
    return this.currentMode;
  }

  getBlockedKeys(): readonly Key[] {
    return [...this.blockedKeys.keys()];
  }

  isBlocked(key: Key): boolean {
    return this.blockedKeys.has(key);
  }

  allowOverwrite(keys?: Key | ReadonlyArray<Key>): void {
    if (keys === undefined) {
      this.blockedKeys.clear();
    } else if (typeof keys === "string") {
      this.blockedKeys.delete(keys);
    } else {
      for (const key of keys) {
        this.blockedKeys.delete(key);
      }
    }

    if (this.currentMode === "blocked") {
      this.currentMode = this.storage ? "local" : "memory";
    }
  }

  prepareJson(value: unknown): JsonStringifyResult {
    return safeJsonStringify(value);
  }

  saveJson(key: Key, value: unknown): SaveResult<Key> {
    const blocked = this.blockedKeys.get(key);
    if (blocked) {
      this.currentMode = "blocked";
      return {
        status: "blocked",
        mode: "blocked",
        key,
        blockedKeys: this.getBlockedKeys(),
        reason: "corrupt-lock",
        corruptBackup: blocked
      };
    }

    const prepared = this.prepareJson(value);
    if (!prepared.ok) {
      return {
        status: "failed",
        mode: this.currentMode === "local" ? "local" : "memory",
        key,
        reason: "serialize-failed",
        error: prepared.error
      };
    }

    if (!this.storage || this.currentMode === "memory") {
      this.currentMode = "memory";
      this.memory.set(key, prepared.json);
      return {
        status: "memory",
        mode: "memory",
        key,
        bytes: prepared.bytes,
        reason: this.storage ? "memory-only" : "storage-unavailable"
      };
    }

    try {
      this.storage.setItem(key, prepared.json);
      this.currentMode = "local";
      return {
        status: "success",
        mode: "local",
        key,
        bytes: prepared.bytes
      };
    } catch {
      this.currentMode = "memory";
      this.memory.set(key, prepared.json);
      return {
        status: "memory",
        mode: "memory",
        key,
        bytes: prepared.bytes,
        reason: "write-failed"
      };
    }
  }

  loadJson<Value = unknown>(key: Key, validator?: JsonValidator<Value>): LoadJsonResult<Key, Value> {
    const memoryValue = this.memory.get(key);
    if (this.currentMode === "memory" && memoryValue !== undefined) {
      return this.parseLoadedJson(key, memoryValue, "memory", validator);
    }

    if (!this.storage) {
      this.currentMode = "memory";
      return {
        status: "missing",
        mode: "memory",
        key
      };
    }

    let rawValue: string | null;
    try {
      rawValue = this.storage.getItem(key);
    } catch (error) {
      this.currentMode = "memory";
      return {
        status: "failed",
        mode: "memory",
        key,
        reason: "read-failed",
        error
      };
    }

    if (rawValue === null) {
      this.currentMode = "local";
      return {
        status: "missing",
        mode: "local",
        key
      };
    }

    return this.parseLoadedJson(key, rawValue, "local", validator);
  }

  archiveCorruptValue(
    key: Key,
    rawValue: string,
    reason: CorruptBackupInfo<Key>["reason"],
    error?: unknown
  ): CorruptBackupInfo<Key> {
    const info = archiveCorruptValue({
      app: this.app,
      sourceKey: key,
      rawValue,
      timestamp: this.now(),
      reason,
      storage: this.storage
    });

    this.blockedKeys.set(key, info);
    this.currentMode = "blocked";
    if (error !== undefined) {
      void error;
    }
    return info;
  }

  private parseLoadedJson<Value>(
    key: Key,
    rawValue: string,
    mode: Exclude<StorageMode, "blocked" | "async-pending">,
    validator?: JsonValidator<Value>
  ): LoadJsonResult<Key, Value> {
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch (error) {
      const corruptBackup = this.archiveCorruptValue(key, rawValue, "json-parse-failed", error);
      return {
        status: "corrupt",
        mode: "blocked",
        key,
        rawValue,
        corruptBackup,
        error
      };
    }

    if (validator && !validator(value)) {
      const corruptBackup = this.archiveCorruptValue(key, rawValue, "required-shape-missing");
      return {
        status: "corrupt",
        mode: "blocked",
        key,
        rawValue,
        corruptBackup
      };
    }

    this.currentMode = mode;
    return {
      status: "success",
      mode,
      key,
      value: value as Value,
      bytes: estimateUtf8Bytes(rawValue)
    };
  }
}

export function archiveCorruptValue<Key extends string>(
  options: ArchiveCorruptValueOptions<Key>
): CorruptBackupInfo<Key> {
  const timestamp = options.timestamp ?? Date.now();
  const backupKey = createCorruptBackupKey(options.sourceKey, timestamp);
  const detectedAtIso = options.detectedAtIso ?? new Date(timestamp).toISOString();
  const bytes = estimateUtf8Bytes(options.rawValue);

  if (!options.storage) {
    return {
      app: options.app,
      sourceKey: options.sourceKey,
      backupKey,
      timestamp,
      detectedAtIso,
      reason: options.reason,
      archiveStatus: "memory-only",
      bytes,
      rawValueAvailable: true,
      exportFileName: options.exportFileName
    };
  }

  try {
    options.storage.setItem(backupKey, options.rawValue);
    return {
      app: options.app,
      sourceKey: options.sourceKey,
      backupKey,
      timestamp,
      detectedAtIso,
      reason: options.reason,
      archiveStatus: "archived",
      bytes,
      rawValueAvailable: true,
      exportFileName: options.exportFileName
    };
  } catch {
    return {
      app: options.app,
      sourceKey: options.sourceKey,
      backupKey,
      timestamp,
      detectedAtIso,
      reason: options.reason,
      archiveStatus: "archive-failed",
      bytes,
      rawValueAvailable: true,
      exportFileName: options.exportFileName
    };
  }
}
