import { describe, expect, it } from "vitest";
import {
  WANOKU_DEMO_CATCH_LOGS_KEY,
  WANOKU_DEMO_SETTINGS_KEY,
  WANOKU_DEMO_BACKUP_TYPE,
  WANOKU_INDEXEDDB_BACKUP_SCHEMA_VERSION,
  WANOKU_INDEXEDDB_BACKUP_TYPE,
  addWanokuCatchLog,
  addWanokuCatchLogForMode,
  createWanokuDemoBackupText,
  createWanokuDemoSettings,
  createWanokuIndexedDbDemoBackupText,
  createWanokuStorageAdapter,
  deleteWanokuCatchLog,
  describeWanokuIndexedDbBackupExportResult,
  describeWanokuIndexedDbLoadResult,
  describeWanokuIndexedDbRestoreResult,
  describeWanokuIndexedDbSaveResult,
  describeWanokuLogStorageModeSaveResult,
  describeWanokuLoadResult,
  describeWanokuRestoreResult,
  describeWanokuSaveResult,
  exportWanokuIndexedDbDemoBackupText,
  getWanokuCatchLogsOrEmpty,
  isWanokuDemoSettings,
  loadWanokuDemoFromIndexedDb,
  loadWanokuDemoBackupData,
  parseWanokuIndexedDbDemoBackupText,
  restoreWanokuIndexedDbDemoBackupText,
  restoreWanokuDemoBackupText,
  saveWanokuCatchLogsForMode,
  saveWanokuDemoToIndexedDb,
  writeWanokuDemoCorruptJson
} from "./storageDemo";
import type { JsonValidator, LoadJsonResult, LocalStorageLike, SaveResult, StorageMode } from "@personal/storage";

class MemoryStorage implements LocalStorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class MemoryAsyncJsonAdapter<Key extends string> {
  readonly values = new Map<Key, string>();
  mode: StorageMode = "local";

  async saveJson(key: Key, value: unknown): Promise<SaveResult<Key>> {
    const json = JSON.stringify(value);
    this.values.set(key, json);

    return {
      status: "success",
      mode: "local",
      key,
      bytes: new TextEncoder().encode(json).byteLength
    };
  }

  async loadJson<Value = unknown>(key: Key, validator?: JsonValidator<Value>): Promise<LoadJsonResult<Key, Value>> {
    const rawValue = this.values.get(key);
    if (rawValue === undefined) {
      return {
        status: "missing",
        mode: "local",
        key
      };
    }

    const value = JSON.parse(rawValue) as unknown;
    if (validator && !validator(value)) {
      return {
        status: "failed",
        mode: "local",
        key,
        reason: "read-failed",
        error: new Error("validation failed")
      };
    }

    return {
      status: "success",
      mode: "local",
      key,
      value: value as Value,
      bytes: new TextEncoder().encode(rawValue).byteLength
    };
  }
}

class FailingAsyncJsonAdapter<Key extends string> extends MemoryAsyncJsonAdapter<Key> {
  async saveJson(key: Key, value: unknown): Promise<SaveResult<Key>> {
    const json = JSON.stringify(value);
    return {
      status: "failed",
      mode: "local",
      key,
      reason: "write-failed",
      bytes: new TextEncoder().encode(json).byteLength,
      error: new Error("indexedDB write failed")
    };
  }
}

describe("wanoku-navi PWA storage demo", () => {
  it("saves demo settings without touching legacy Store keys", () => {
    const storage = new MemoryStorage();
    const adapter = createWanokuStorageAdapter(storage);

    const result = adapter.saveJson(WANOKU_DEMO_SETTINGS_KEY, createWanokuDemoSettings(new Date("2026-07-10T00:00:00.000Z")));

    expect(result.status).toBe("success");
    expect(storage.getItem(WANOKU_DEMO_SETTINGS_KEY)).toContain("wanoku-pwa-demo");
    expect(storage.getItem("settings")).toBeNull();
    expect(storage.getItem("logs")).toBeNull();
    expect(describeWanokuSaveResult(result)).toContain("保存成功");
  });

  it("detects corrupt demo data and reports the corrupt backup key", () => {
    const storage = new MemoryStorage();
    const adapter = createWanokuStorageAdapter(storage);

    writeWanokuDemoCorruptJson(storage);
    const result = adapter.loadJson(WANOKU_DEMO_SETTINGS_KEY, isWanokuDemoSettings);

    expect(result.status).toBe("corrupt");
    expect(describeWanokuLoadResult(result, adapter.mode)).toContain(`${WANOKU_DEMO_SETTINGS_KEY}.corrupt.`);
  });

  it("exports and restores demo backup JSON", () => {
    const storage = new MemoryStorage();
    const adapter = createWanokuStorageAdapter(storage);
    const addResult = addWanokuCatchLog(adapter, {
      id: "catch-1",
      date: "2026-07-10",
      spotName: "豊洲",
      targetFish: "シーバス",
      result: "1匹",
      lure: "ミノー"
    });
    expect(addResult.ok).toBe(true);
    const backupText = createWanokuDemoBackupText(
      {
        settings: createWanokuDemoSettings(new Date("2026-07-10T00:00:00.000Z")),
        catchLogs: getWanokuCatchLogsOrEmpty(adapter)
      },
      "2026-07-10T00:00:00.000Z"
    );

    const result = restoreWanokuDemoBackupText(adapter, backupText);

    expect(result.status).toBe("restored");
    expect(storage.getItem(WANOKU_DEMO_SETTINGS_KEY)).toContain("wanoku-pwa-demo");
    expect(storage.getItem(WANOKU_DEMO_CATCH_LOGS_KEY)).toContain("catch-1");
    expect(describeWanokuRestoreResult(result)).toContain("復元結果");
  });

  it("rejects corrupt backup JSON and appId mismatch", () => {
    const storage = new MemoryStorage();
    const adapter = createWanokuStorageAdapter(storage);
    const corrupt = restoreWanokuDemoBackupText(adapter, "{broken-json");
    const runosBackup = JSON.stringify({
      backupType: "wanoku-pwa-demo-data",
      appId: "runos",
      schemaVersion: "wanoku-pwa-demo-data-v1",
      createdAt: "2026-07-10T00:00:00.000Z",
      data: {
        settings: createWanokuDemoSettings(new Date("2026-07-10T00:00:00.000Z")),
        catchLogs: []
      },
      checksum: {
        algorithm: "byte-length-and-char-sum-v1",
        bytes: 1,
        sum: 1
      }
    });
    const mismatch = restoreWanokuDemoBackupText(adapter, runosBackup);

    expect(corrupt).toMatchObject({ status: "rejected", reason: "json-parse-failed" });
    expect(mismatch).toMatchObject({ status: "rejected", reason: "app-id-mismatch" });
    expect(storage.getItem(WANOKU_DEMO_SETTINGS_KEY)).toBeNull();
  });

  it("adds and deletes lightweight catch logs using only demo keys", () => {
    const storage = new MemoryStorage();
    const adapter = createWanokuStorageAdapter(storage);

    const added = addWanokuCatchLog(adapter, {
      id: "catch-1",
      date: "2026-07-10",
      spotName: "豊洲",
      targetFish: "シーバス",
      result: "1匹",
      note: "短時間"
    });

    expect(added.ok).toBe(true);
    expect(getWanokuCatchLogsOrEmpty(adapter)).toHaveLength(1);
    expect(storage.getItem(WANOKU_DEMO_CATCH_LOGS_KEY)).toContain("豊洲");
    expect(storage.getItem("logs")).toBeNull();

    const deleted = deleteWanokuCatchLog(adapter, "catch-1");
    expect(deleted.status).toBe("success");
    expect(getWanokuCatchLogsOrEmpty(adapter)).toHaveLength(0);
  });

  it("includes settings and catch logs in backup data", () => {
    const storage = new MemoryStorage();
    const adapter = createWanokuStorageAdapter(storage);
    addWanokuCatchLog(adapter, {
      id: "catch-1",
      date: "2026-07-10",
      spotName: "豊洲",
      targetFish: "シーバス",
      result: "1匹"
    });

    const data = loadWanokuDemoBackupData(adapter);

    expect(data.settings.app).toBe("wanoku-pwa-demo");
    expect(data.catchLogs).toHaveLength(1);
  });

  it("copies demo settings and catch logs to the IndexedDB opt-in adapter without touching legacy Store keys", async () => {
    const storage = new MemoryStorage();
    const localAdapter = createWanokuStorageAdapter(storage);
    const indexedDbAdapter = new MemoryAsyncJsonAdapter<typeof WANOKU_DEMO_SETTINGS_KEY | typeof WANOKU_DEMO_CATCH_LOGS_KEY>();

    const added = addWanokuCatchLog(localAdapter, {
      id: "catch-idb-1",
      date: "2026-07-10",
      spotName: "豊洲",
      targetFish: "シーバス",
      result: "1匹",
      note: "idb opt-in"
    });
    expect(added.ok).toBe(true);

    const saved = await saveWanokuDemoToIndexedDb(indexedDbAdapter, localAdapter, new Date("2026-07-10T00:00:00.000Z"));
    const loaded = await loadWanokuDemoFromIndexedDb(indexedDbAdapter, new Date("2026-07-10T00:01:00.000Z"));

    expect(saved.settingsResult.status).toBe("success");
    expect(saved.catchLogsResult.status).toBe("success");
    expect(saved.catchLogCount).toBe(1);
    expect(loaded.settingsResult.status).toBe("success");
    expect(loaded.catchLogsResult.status).toBe("success");
    expect(loaded.catchLogCount).toBe(1);
    expect(describeWanokuIndexedDbSaveResult(saved)).toContain("保存先: IndexedDB");
    expect(describeWanokuIndexedDbLoadResult(loaded)).toContain("件数: catchLogs=1");
    expect(storage.getItem("settings")).toBeNull();
    expect(storage.getItem("logs")).toBeNull();
  });

  it("exports and restores IndexedDB opt-in backup JSON with a distinct backupType", async () => {
    const storage = new MemoryStorage();
    const localAdapter = createWanokuStorageAdapter(storage);
    const sourceIndexedDb = new MemoryAsyncJsonAdapter<typeof WANOKU_DEMO_SETTINGS_KEY | typeof WANOKU_DEMO_CATCH_LOGS_KEY>();
    const restoreIndexedDb = new MemoryAsyncJsonAdapter<typeof WANOKU_DEMO_SETTINGS_KEY | typeof WANOKU_DEMO_CATCH_LOGS_KEY>();

    addWanokuCatchLog(localAdapter, {
      id: "catch-idb-backup-1",
      date: "2026-07-10",
      spotName: "豊洲",
      targetFish: "シーバス",
      result: "1匹",
      note: "idb backup"
    });
    await saveWanokuDemoToIndexedDb(sourceIndexedDb, localAdapter, new Date("2026-07-10T00:00:00.000Z"));

    const exported = await exportWanokuIndexedDbDemoBackupText(sourceIndexedDb, new Date("2026-07-10T00:02:00.000Z"));
    expect(exported.status).toBe("exported");
    if (exported.status !== "exported") throw new Error("IndexedDB backup export failed in test.");
    expect(exported.backup.backupType).toBe(WANOKU_INDEXEDDB_BACKUP_TYPE);
    expect(exported.backup.backupType).not.toBe(WANOKU_DEMO_BACKUP_TYPE);
    expect(exported.backup.schemaVersion).toBe(WANOKU_INDEXEDDB_BACKUP_SCHEMA_VERSION);
    expect(describeWanokuIndexedDbBackupExportResult(exported)).toContain("catchLogs=1");

    const parsed = parseWanokuIndexedDbDemoBackupText(exported.backupText);
    expect(parsed.ok).toBe(true);

    const restored = await restoreWanokuIndexedDbDemoBackupText(restoreIndexedDb, exported.backupText);
    const loaded = await loadWanokuDemoFromIndexedDb(restoreIndexedDb);

    expect(restored.status).toBe("restored");
    expect(describeWanokuIndexedDbRestoreResult(restored)).toContain("catchLogs=1");
    expect(loaded.catchLogCount).toBe(1);
  });

  it("rejects localStorage backup and checksum mismatch for IndexedDB restore", async () => {
    const indexedDbAdapter = new MemoryAsyncJsonAdapter<typeof WANOKU_DEMO_SETTINGS_KEY | typeof WANOKU_DEMO_CATCH_LOGS_KEY>();
    const localBackup = createWanokuDemoBackupText(
      {
        settings: createWanokuDemoSettings(new Date("2026-07-10T00:00:00.000Z")),
        catchLogs: []
      },
      "2026-07-10T00:00:00.000Z"
    );
    const localBackupResult = await restoreWanokuIndexedDbDemoBackupText(indexedDbAdapter, localBackup);
    expect(localBackupResult).toMatchObject({ status: "rejected", reason: "backup-type-mismatch" });

    const idbBackup = createWanokuIndexedDbDemoBackupText(
      {
        settings: createWanokuDemoSettings(new Date("2026-07-10T00:00:00.000Z")),
        catchLogs: []
      },
      "2026-07-10T00:00:00.000Z"
    );
    const badChecksumJson = JSON.parse(idbBackup) as { checksum: { sum: number } };
    badChecksumJson.checksum.sum += 1;
    const badChecksum = JSON.stringify(badChecksumJson);
    const checksumResult = await restoreWanokuIndexedDbDemoBackupText(indexedDbAdapter, badChecksum);
    expect(checksumResult).toMatchObject({ status: "rejected", reason: "checksum-mismatch" });
  });

  it("keeps lightweight catch log storage mode on localStorage by default", async () => {
    const storage = new MemoryStorage();
    const localAdapter = createWanokuStorageAdapter(storage);
    const indexedDbAdapter = new MemoryAsyncJsonAdapter<typeof WANOKU_DEMO_SETTINGS_KEY | typeof WANOKU_DEMO_CATCH_LOGS_KEY>();

    const result = await addWanokuCatchLogForMode(
      "localStorage",
      localAdapter,
      indexedDbAdapter,
      {
        id: "catch-mode-local",
        date: "2026-07-10",
        spotName: "豊洲",
        targetFish: "シーバス",
        result: "1匹"
      },
      new Date("2026-07-10T00:03:00.000Z")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("catch log mode save failed in test.");
    expect(result.saveResult.status).toBe("success");
    expect(result.saveResult.canonicalSource).toBe("localStorage");
    expect(storage.getItem(WANOKU_DEMO_CATCH_LOGS_KEY)).toContain("catch-mode-local");
    expect(indexedDbAdapter.values.size).toBe(0);
    expect(describeWanokuLogStorageModeSaveResult(result.saveResult)).toContain("正本: localStorage");
  });

  it("can save lightweight catch logs to indexedDB mode without writing localStorage", async () => {
    const storage = new MemoryStorage();
    const localAdapter = createWanokuStorageAdapter(storage);
    const indexedDbAdapter = new MemoryAsyncJsonAdapter<typeof WANOKU_DEMO_SETTINGS_KEY | typeof WANOKU_DEMO_CATCH_LOGS_KEY>();

    const result = await addWanokuCatchLogForMode(
      "indexedDB",
      localAdapter,
      indexedDbAdapter,
      {
        id: "catch-mode-idb",
        date: "2026-07-10",
        spotName: "豊洲",
        targetFish: "シーバス",
        result: "1匹"
      },
      new Date("2026-07-10T00:04:00.000Z")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("catch log idb mode save failed in test.");
    expect(result.saveResult.status).toBe("success");
    expect(result.saveResult.canonicalSource).toBe("indexedDB");
    expect(storage.getItem(WANOKU_DEMO_CATCH_LOGS_KEY)).toBeNull();
    expect(indexedDbAdapter.values.get(WANOKU_DEMO_CATCH_LOGS_KEY)).toContain("catch-mode-idb");
  });

  it("does not treat dual-write as success when indexedDB fails", async () => {
    const storage = new MemoryStorage();
    const localAdapter = createWanokuStorageAdapter(storage);
    const failingIndexedDb = new FailingAsyncJsonAdapter<typeof WANOKU_DEMO_SETTINGS_KEY | typeof WANOKU_DEMO_CATCH_LOGS_KEY>();

    const result = await saveWanokuCatchLogsForMode(
      "dual-write",
      localAdapter,
      failingIndexedDb,
      [
        {
          id: "catch-mode-dual",
          date: "2026-07-10",
          spotName: "豊洲",
          targetFish: "シーバス",
          result: "1匹",
          lure: "",
          note: ""
        }
      ],
      new Date("2026-07-10T00:05:00.000Z")
    );

    expect(result.status).toBe("partial");
    expect(result.canonicalSource).toBe("localStorage");
    expect(result.failedTargets).toEqual(["indexedDB"]);
    expect(storage.getItem(WANOKU_DEMO_CATCH_LOGS_KEY)).toContain("catch-mode-dual");
    expect(describeWanokuLogStorageModeSaveResult(result)).toContain("失敗先: indexedDB");
  });
});
