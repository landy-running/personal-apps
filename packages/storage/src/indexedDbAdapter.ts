import {
  type AppId,
  type CorruptBackupInfo,
  type SaveFailureReason,
  type SaveResult,
  type StorageMode,
  createCorruptBackupKey
} from "./contracts";
import { type JsonStringifyResult, estimateUtf8Bytes, safeJsonStringify } from "./json";
import { type JsonValidator, type LoadJsonResult } from "./localStorageAdapter";

export type IndexedDbErrorKind = "quota" | "blocked" | "unavailable" | "validation" | "unknown";

export class IndexedDbAdapterError extends Error {
  readonly kind: IndexedDbErrorKind;
  readonly cause?: unknown;

  constructor(kind: IndexedDbErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "IndexedDbAdapterError";
    this.kind = kind;
    this.cause = cause;
  }
}

export type IndexedDbRequestLike<T = unknown> = {
  result?: T;
  error?: unknown;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type IndexedDbOpenRequestLike = IndexedDbRequestLike<IndexedDbDatabaseLike> & {
  onupgradeneeded: ((event: unknown) => void) | null;
  onblocked: ((event: unknown) => void) | null;
};

export type IndexedDbObjectStoreNamesLike = {
  contains(name: string): boolean;
};

export type IndexedDbDatabaseLike = {
  readonly objectStoreNames: IndexedDbObjectStoreNamesLike;
  createObjectStore(name: string): unknown;
  transaction(storeName: string, mode: "readonly" | "readwrite"): IndexedDbTransactionLike;
  close(): void;
};

export type IndexedDbTransactionLike = {
  error?: unknown;
  objectStore(storeName: string): IndexedDbObjectStoreLike;
  oncomplete: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onabort: ((event: unknown) => void) | null;
};

export type IndexedDbObjectStoreLike = {
  get(key: string): IndexedDbRequestLike<unknown>;
  put(value: unknown, key: string): IndexedDbRequestLike<unknown>;
  delete(key: string): IndexedDbRequestLike<unknown>;
};

export type IndexedDbFactoryLike = {
  open(name: string, version?: number): IndexedDbOpenRequestLike;
};

export type IndexedDbAdapterOptions = {
  app: AppId;
  dbName: string;
  version: number;
  storeName: string;
  indexedDB?: IndexedDbFactoryLike;
  now?: () => number;
};

export type IndexedDbJsonAdapterContract<Key extends string = string> = {
  readonly mode: StorageMode;
  open(): Promise<void>;
  loadJson<Value = unknown>(key: Key, validator?: JsonValidator<Value>): Promise<LoadJsonResult<Key, Value>>;
  saveJson(key: Key, value: unknown): Promise<SaveResult<Key>>;
  delete(key: Key): Promise<SaveResult<Key>>;
  archiveCorruptValue(
    key: Key,
    rawValue: string,
    reason: CorruptBackupInfo<Key>["reason"]
  ): Promise<CorruptBackupInfo<Key>>;
};

export class IndexedDbJsonAdapter<Key extends string = string> implements IndexedDbJsonAdapterContract<Key> {
  private readonly app: AppId;
  private readonly dbName: string;
  private readonly version: number;
  private readonly storeName: string;
  private readonly indexedDB?: IndexedDbFactoryLike;
  private readonly now: () => number;
  private readonly blockedKeys = new Map<Key, CorruptBackupInfo<Key>>();
  private db?: IndexedDbDatabaseLike;
  private currentMode: StorageMode = "async-pending";

  constructor(options: IndexedDbAdapterOptions) {
    this.app = options.app;
    this.dbName = options.dbName;
    this.version = options.version;
    this.storeName = options.storeName;
    this.indexedDB = options.indexedDB;
    this.now = options.now ?? Date.now;
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
      this.currentMode = this.db ? "local" : "async-pending";
    }
  }

  async open(): Promise<void> {
    await this.ensureDb();
  }

  prepareJson(value: unknown): JsonStringifyResult {
    return safeJsonStringify(value);
  }

  async saveJson(key: Key, value: unknown): Promise<SaveResult<Key>> {
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
        mode: this.failureMode("validation"),
        key,
        reason: "serialize-failed",
        error: prepared.error
      };
    }

    try {
      await this.putRaw(key, prepared.json);
      this.currentMode = "local";
      return {
        status: "success",
        mode: "local",
        key,
        bytes: prepared.bytes
      };
    } catch (error) {
      const kind = classifyIndexedDbError(error);
      this.applyFailureMode(kind);
      return {
        status: "failed",
        mode: this.failureMode(kind),
        key,
        reason: saveFailureReasonFromIndexedDbError(kind),
        bytes: prepared.bytes,
        error
      };
    }
  }

  async loadJson<Value = unknown>(key: Key, validator?: JsonValidator<Value>): Promise<LoadJsonResult<Key, Value>> {
    let rawValue: string | undefined;

    try {
      rawValue = await this.getRaw(key);
    } catch (error) {
      const kind = classifyIndexedDbError(error);
      this.applyFailureMode(kind);
      return {
        status: "failed",
        mode: this.failureMode(kind),
        key,
        reason: "read-failed",
        error
      };
    }

    if (rawValue === undefined) {
      this.currentMode = "local";
      return {
        status: "missing",
        mode: "local",
        key
      };
    }

    return this.parseLoadedJson(key, rawValue, validator);
  }

  async delete(key: Key): Promise<SaveResult<Key>> {
    try {
      await this.runWithStore("readwrite", (store) => requestToPromise(store.delete(key)));
      this.blockedKeys.delete(key);
      this.currentMode = "local";
      return {
        status: "success",
        mode: "local",
        key,
        bytes: 0
      };
    } catch (error) {
      const kind = classifyIndexedDbError(error);
      this.applyFailureMode(kind);
      return {
        status: "failed",
        mode: this.failureMode(kind),
        key,
        reason: saveFailureReasonFromIndexedDbError(kind),
        error
      };
    }
  }

  async archiveCorruptValue(
    key: Key,
    rawValue: string,
    reason: CorruptBackupInfo<Key>["reason"]
  ): Promise<CorruptBackupInfo<Key>> {
    const timestamp = this.now();
    const backupKey = createCorruptBackupKey(key, timestamp);
    const detectedAtIso = new Date(timestamp).toISOString();
    const bytes = estimateUtf8Bytes(rawValue);
    let archiveStatus: CorruptBackupInfo<Key>["archiveStatus"] = "archived";

    try {
      await this.putRawKey(backupKey, rawValue);
    } catch (error) {
      const kind = classifyIndexedDbError(error);
      archiveStatus = kind === "unavailable" ? "memory-only" : "archive-failed";
    }

    const info: CorruptBackupInfo<Key> = {
      app: this.app,
      sourceKey: key,
      backupKey,
      timestamp,
      detectedAtIso,
      reason,
      archiveStatus,
      bytes,
      rawValueAvailable: true
    };

    this.blockedKeys.set(key, info);
    this.currentMode = "blocked";
    return info;
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.currentMode = "async-pending";
  }

  private async parseLoadedJson<Value>(
    key: Key,
    rawValue: string,
    validator?: JsonValidator<Value>
  ): Promise<LoadJsonResult<Key, Value>> {
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch (error) {
      const corruptBackup = await this.archiveCorruptValue(key, rawValue, "json-parse-failed");
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
      const corruptBackup = await this.archiveCorruptValue(key, rawValue, "required-shape-missing");
      return {
        status: "corrupt",
        mode: "blocked",
        key,
        rawValue,
        corruptBackup
      };
    }

    this.currentMode = "local";
    return {
      status: "success",
      mode: "local",
      key,
      value: value as Value,
      bytes: estimateUtf8Bytes(rawValue)
    };
  }

  private async getRaw(key: Key): Promise<string | undefined> {
    const value = await this.runWithStore("readonly", (store) => requestToPromise(store.get(key)));

    if (value === undefined) {
      return undefined;
    }

    if (typeof value === "string") {
      return value;
    }

    throw new IndexedDbAdapterError("validation", "IndexedDB record is not a JSON string.");
  }

  private async putRaw(key: Key, rawValue: string): Promise<void> {
    await this.putRawKey(key, rawValue);
  }

  private async putRawKey(key: string, rawValue: string): Promise<void> {
    await this.runWithStore("readwrite", (store) => requestToPromise(store.put(rawValue, key)));
  }

  private async runWithStore<T>(
    mode: "readonly" | "readwrite",
    operation: (store: IndexedDbObjectStoreLike) => Promise<T>
  ): Promise<T> {
    const db = await this.ensureDb();
    const transaction = db.transaction(this.storeName, mode);
    const done = transactionToPromise(transaction);

    try {
      const result = await operation(transaction.objectStore(this.storeName));
      await done;
      return result;
    } catch (error) {
      done.catch(() => undefined);
      throw error;
    }
  }

  private async ensureDb(): Promise<IndexedDbDatabaseLike> {
    if (this.db) {
      return this.db;
    }

    const indexedDB = this.indexedDB ?? getGlobalIndexedDb();
    if (!indexedDB) {
      this.currentMode = "memory";
      throw new IndexedDbAdapterError("unavailable", "IndexedDB is not available.");
    }

    this.currentMode = "async-pending";
    return new Promise((resolve, reject) => {
      let request: IndexedDbOpenRequestLike;

      try {
        request = indexedDB.open(this.dbName, this.version);
      } catch (error) {
        const kind = classifyIndexedDbError(error);
        this.applyFailureMode(kind);
        reject(new IndexedDbAdapterError(kind, "IndexedDB open failed.", error));
        return;
      }

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db) {
          return;
        }
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        if (!db) {
          this.applyFailureMode("unknown");
          reject(new IndexedDbAdapterError("unknown", "IndexedDB open succeeded without a database result."));
          return;
        }

        this.db = db;
        this.currentMode = "local";
        resolve(db);
      };

      request.onerror = () => {
        const error = request.error ?? new IndexedDbAdapterError("unknown", "IndexedDB open failed.");
        const kind = classifyIndexedDbError(error);
        this.applyFailureMode(kind);
        reject(new IndexedDbAdapterError(kind, "IndexedDB open failed.", error));
      };

      request.onblocked = () => {
        this.currentMode = "blocked";
        reject(new IndexedDbAdapterError("blocked", "IndexedDB open was blocked by another connection."));
      };
    });
  }

  private applyFailureMode(kind: IndexedDbErrorKind): void {
    if (kind === "blocked") {
      this.currentMode = "blocked";
    } else if (kind === "unavailable") {
      this.currentMode = "memory";
    } else {
      this.currentMode = this.db ? "local" : "async-pending";
    }
  }

  private failureMode(kind: IndexedDbErrorKind): Exclude<StorageMode, "blocked" | "async-pending"> {
    return kind === "unavailable" ? "memory" : "local";
  }
}

export function classifyIndexedDbError(error: unknown): IndexedDbErrorKind {
  if (error instanceof IndexedDbAdapterError) {
    return error.kind;
  }

  const name = getErrorName(error);
  if (name === "QuotaExceededError") {
    return "quota";
  }

  if (name === "InvalidStateError" || name === "VersionError" || name === "BlockedError") {
    return "blocked";
  }

  if (name === "NotSupportedError" || name === "SecurityError") {
    return "unavailable";
  }

  if (name === "DataError" || name === "DataCloneError" || name === "ValidationError") {
    return "validation";
  }

  return "unknown";
}

export function saveFailureReasonFromIndexedDbError(kind: IndexedDbErrorKind): SaveFailureReason {
  switch (kind) {
    case "quota":
      return "quota-exceeded";
    case "blocked":
      return "blocked";
    case "unavailable":
      return "storage-unavailable";
    case "validation":
      return "validation-failed";
    case "unknown":
      return "unknown";
  }
}

function getGlobalIndexedDb(): IndexedDbFactoryLike | undefined {
  return typeof globalThis.indexedDB === "undefined"
    ? undefined
    : (globalThis.indexedDB as unknown as IndexedDbFactoryLike);
}

function getErrorName(error: unknown): string {
  if (error && typeof error === "object" && "name" in error) {
    const name = (error as { name?: unknown }).name;
    return typeof name === "string" ? name : "";
  }

  return "";
}

function requestToPromise<T>(request: IndexedDbRequestLike<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result as T);
    };

    request.onerror = () => {
      reject(request.error ?? new IndexedDbAdapterError("unknown", "IndexedDB request failed."));
    };
  });
}

function transactionToPromise(transaction: IndexedDbTransactionLike): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onerror = () => {
      reject(transaction.error ?? new IndexedDbAdapterError("unknown", "IndexedDB transaction failed."));
    };

    transaction.onabort = () => {
      reject(transaction.error ?? new IndexedDbAdapterError("unknown", "IndexedDB transaction aborted."));
    };
  });
}
