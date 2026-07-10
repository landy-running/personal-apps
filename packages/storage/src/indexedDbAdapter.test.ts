import { describe, expect, it } from "vitest";
import {
  IndexedDbAdapterError,
  IndexedDbJsonAdapter,
  classifyIndexedDbError,
  saveFailureReasonFromIndexedDbError,
  type IndexedDbDatabaseLike,
  type IndexedDbFactoryLike,
  type IndexedDbObjectStoreLike,
  type IndexedDbObjectStoreNamesLike,
  type IndexedDbOpenRequestLike,
  type IndexedDbRequestLike,
  type IndexedDbTransactionLike
} from "./index";

class FakeRequest<T = unknown> implements IndexedDbRequestLike<T> {
  result?: T;
  error?: unknown;
  onsuccess: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  succeed(result: T): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.({ type: "success" }));
  }

  fail(error: unknown): void {
    this.error = error;
    queueMicrotask(() => this.onerror?.({ type: "error" }));
  }
}

class FakeOpenRequest extends FakeRequest<IndexedDbDatabaseLike> implements IndexedDbOpenRequestLike {
  onupgradeneeded: ((event: unknown) => void) | null = null;
  onblocked: ((event: unknown) => void) | null = null;
}

class FakeObjectStoreNames implements IndexedDbObjectStoreNamesLike {
  constructor(private readonly stores: Map<string, Map<string, unknown>>) {}

  contains(name: string): boolean {
    return this.stores.has(name);
  }
}

class FakeDatabase implements IndexedDbDatabaseLike {
  readonly stores = new Map<string, Map<string, unknown>>();
  readonly objectStoreNames = new FakeObjectStoreNames(this.stores);

  constructor(private readonly factory: FakeIndexedDbFactory) {}

  createObjectStore(name: string): unknown {
    if (!this.stores.has(name)) {
      this.stores.set(name, new Map<string, unknown>());
    }
    return {};
  }

  transaction(storeName: string): IndexedDbTransactionLike {
    const values = this.stores.get(storeName);
    if (!values) {
      throw new IndexedDbAdapterError("validation", `Missing object store: ${storeName}`);
    }
    return new FakeTransaction(values, this.factory);
  }

  close(): void {
    return undefined;
  }
}

class FakeTransaction implements IndexedDbTransactionLike {
  error?: unknown;
  oncomplete: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onabort: ((event: unknown) => void) | null = null;

  constructor(
    private readonly values: Map<string, unknown>,
    private readonly factory: FakeIndexedDbFactory
  ) {}

  objectStore(): IndexedDbObjectStoreLike {
    return new FakeObjectStore(this.values, this, this.factory);
  }

  complete(): void {
    queueMicrotask(() => this.oncomplete?.({ type: "complete" }));
  }

  fail(error: unknown): void {
    this.error = error;
    queueMicrotask(() => this.onerror?.({ type: "error" }));
  }
}

class FakeObjectStore implements IndexedDbObjectStoreLike {
  constructor(
    private readonly values: Map<string, unknown>,
    private readonly transaction: FakeTransaction,
    private readonly factory: FakeIndexedDbFactory
  ) {}

  get(key: string): IndexedDbRequestLike<unknown> {
    const request = new FakeRequest<unknown>();
    queueMicrotask(() => {
      request.succeed(this.values.get(key));
      this.transaction.complete();
    });
    return request;
  }

  put(value: unknown, key: string): IndexedDbRequestLike<unknown> {
    const request = new FakeRequest<unknown>();
    queueMicrotask(() => {
      const error = this.factory.consumeNextPutError();
      if (error) {
        request.fail(error);
        this.transaction.fail(error);
        return;
      }

      this.values.set(key, value);
      request.succeed(key);
      this.transaction.complete();
    });
    return request;
  }

  delete(key: string): IndexedDbRequestLike<unknown> {
    const request = new FakeRequest<unknown>();
    queueMicrotask(() => {
      this.values.delete(key);
      request.succeed(undefined);
      this.transaction.complete();
    });
    return request;
  }
}

class FakeIndexedDbFactory implements IndexedDbFactoryLike {
  readonly databases = new Map<string, FakeDatabase>();
  blockedOpen = false;
  nextOpenError?: unknown;
  nextPutError?: unknown;

  open(name: string): IndexedDbOpenRequestLike {
    const request = new FakeOpenRequest();
    queueMicrotask(() => {
      if (this.blockedOpen) {
        request.onblocked?.({ type: "blocked" });
        return;
      }

      if (this.nextOpenError) {
        request.fail(this.nextOpenError);
        this.nextOpenError = undefined;
        return;
      }

      let database = this.databases.get(name);
      const needsUpgrade = !database;
      if (!database) {
        database = new FakeDatabase(this);
        this.databases.set(name, database);
      }

      request.result = database;
      if (needsUpgrade) {
        request.onupgradeneeded?.({ type: "upgradeneeded" });
      }
      request.succeed(database);
    });

    return request;
  }

  consumeNextPutError(): unknown {
    const error = this.nextPutError;
    this.nextPutError = undefined;
    return error;
  }
}

describe("IndexedDbJsonAdapter", () => {
  it("opens an IndexedDB database and creates the configured object store", async () => {
    const factory = new FakeIndexedDbFactory();
    const adapter = createAdapter(factory);

    await adapter.open();

    expect(adapter.mode).toBe("local");
    expect(factory.databases.get("runos-pwa")?.objectStoreNames.contains("kv")).toBe(true);
  });

  it("saves and loads JSON values with serialized size", async () => {
    const adapter = createAdapter(new FakeIndexedDbFactory());

    const saved = await adapter.saveJson("settings", { app: "runos-pwa-demo" });
    const loaded = await adapter.loadJson("settings", isRecord);

    expect(saved.status).toBe("success");
    if (saved.status === "success") {
      expect(saved.bytes).toBeGreaterThan(0);
    }
    expect(loaded.status).toBe("success");
    if (loaded.status === "success") {
      expect(loaded.value).toEqual({ app: "runos-pwa-demo" });
      expect(loaded.bytes).toBeGreaterThan(0);
    }
  });

  it("treats validation failures as corrupt data and blocks later writes for that key", async () => {
    const adapter = createAdapter(new FakeIndexedDbFactory(), 1783600000000);

    await adapter.saveJson("settings", { app: "runos-pwa-demo" });
    const loaded = await adapter.loadJson("settings", Array.isArray);

    expect(loaded.status).toBe("corrupt");
    if (loaded.status === "corrupt") {
      expect(loaded.corruptBackup.reason).toBe("required-shape-missing");
      expect(loaded.corruptBackup.backupKey).toBe("settings.corrupt.1783600000000");
      expect(loaded.corruptBackup.archiveStatus).toBe("archived");
    }

    const blocked = await adapter.saveJson("settings", { app: "new" });
    expect(blocked.status).toBe("blocked");
  });

  it("deletes a saved JSON value", async () => {
    const adapter = createAdapter(new FakeIndexedDbFactory());

    await adapter.saveJson("settings", { app: "runos-pwa-demo" });
    const deleted = await adapter.delete("settings");
    const loaded = await adapter.loadJson("settings", isRecord);

    expect(deleted.status).toBe("success");
    expect(loaded.status).toBe("missing");
  });

  it("archives corrupt raw values using the generic <key>.corrupt.<timestamp> key", async () => {
    const adapter = createAdapter(new FakeIndexedDbFactory(), 1783600000001);

    const info = await adapter.archiveCorruptValue("settings", "{broken-json", "json-parse-failed");
    const archived = await adapter.loadJson("settings.corrupt.1783600000001", (value): value is unknown => true);

    expect(info.backupKey).toBe("settings.corrupt.1783600000001");
    expect(info.archiveStatus).toBe("archived");
    expect(archived.status).toBe("corrupt");
    if (archived.status === "corrupt") {
      expect(archived.rawValue).toBe("{broken-json");
    }
  });

  it("maps save failures to SaveResult failed reasons", async () => {
    const factory = new FakeIndexedDbFactory();
    const adapter = createAdapter(factory);
    factory.nextPutError = namedError("QuotaExceededError", "quota exceeded");

    const result = await adapter.saveJson("settings", { app: "runos-pwa-demo" });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("quota-exceeded");
      expect(result.bytes).toBeGreaterThan(0);
    }
  });

  it("classifies IndexedDB errors used by the adapter", () => {
    expect(classifyIndexedDbError(namedError("QuotaExceededError", "quota"))).toBe("quota");
    expect(classifyIndexedDbError(namedError("InvalidStateError", "blocked"))).toBe("blocked");
    expect(classifyIndexedDbError(namedError("SecurityError", "unavailable"))).toBe("unavailable");
    expect(classifyIndexedDbError(namedError("DataError", "validation"))).toBe("validation");
    expect(classifyIndexedDbError(new Error("wat"))).toBe("unknown");
    expect(saveFailureReasonFromIndexedDbError("validation")).toBe("validation-failed");
  });
});

function createAdapter(factory: FakeIndexedDbFactory, now = 1783600000000): IndexedDbJsonAdapter<string> {
  return new IndexedDbJsonAdapter<string>({
    app: "runos",
    dbName: "runos-pwa",
    version: 1,
    storeName: "kv",
    indexedDB: factory,
    now: () => now
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

