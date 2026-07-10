import { describe, expect, it } from "vitest";
import {
  RUNOS_DEMO_RUN_LOGS_KEY,
  RUNOS_DEMO_SETTINGS_KEY,
  RUNOS_DEMO_BACKUP_TYPE,
  RUNOS_INDEXEDDB_BACKUP_SCHEMA_VERSION,
  RUNOS_INDEXEDDB_BACKUP_TYPE,
  addRunosRunLog,
  addRunosRunLogForMode,
  createRunosIndexedDbDemoBackupText,
  createRunosDemoBackupText,
  createRunosDemoBackupFileName,
  createRunosDemoSettings,
  createRunosStorageAdapter,
  deleteRunosRunLog,
  describeRunosIndexedDbBackupExportResult,
  describeRunosIndexedDbLoadResult,
  describeRunosIndexedDbRestoreResult,
  describeRunosIndexedDbSaveResult,
  describeRunosLogStorageModeSaveResult,
  describeRunosLoadResult,
  describeRunosRestoreResult,
  describeRunosSaveResult,
  exportRunosIndexedDbDemoBackupText,
  getRunosRunLogsOrEmpty,
  isRunosDemoSettings,
  loadRunosDemoFromIndexedDb,
  loadRunosDemoBackupData,
  parseRunosIndexedDbDemoBackupText,
  parseRunosDemoBackupText,
  restoreRunosIndexedDbDemoBackupText,
  restoreRunosDemoBackupText,
  saveRunosRunLogsForMode,
  saveRunosDemoToIndexedDb,
  saveRunosRunLogs,
  writeRunosDemoCorruptJson
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

describe("RunOS PWA storage demo", () => {
  it("saves demo settings without touching the legacy key", () => {
    const storage = new MemoryStorage();
    const adapter = createRunosStorageAdapter(storage);

    const result = adapter.saveJson(RUNOS_DEMO_SETTINGS_KEY, createRunosDemoSettings(new Date("2026-07-10T00:00:00.000Z")));

    expect(result.status).toBe("success");
    expect(storage.getItem(RUNOS_DEMO_SETTINGS_KEY)).toContain("runos-pwa-demo");
    expect(storage.getItem("meridian.v1")).toBeNull();
    expect(describeRunosSaveResult(result)).toContain("保存成功");
  });

  it("detects corrupt demo data and reports the corrupt backup key", () => {
    const storage = new MemoryStorage();
    const adapter = createRunosStorageAdapter(storage);

    writeRunosDemoCorruptJson(storage);
    const result = adapter.loadJson(RUNOS_DEMO_SETTINGS_KEY, isRunosDemoSettings);

    expect(result.status).toBe("corrupt");
    expect(describeRunosLoadResult(result, adapter.mode)).toContain(`${RUNOS_DEMO_SETTINGS_KEY}.corrupt.`);
  });

  it("exports and restores demo backup JSON", () => {
    const storage = new MemoryStorage();
    const adapter = createRunosStorageAdapter(storage);
    const addResult = addRunosRunLog(adapter, {
      id: "run-1",
      date: "2026-07-10",
      distanceKm: 5,
      durationSec: 1500,
      note: "jog"
    });
    expect(addResult.ok).toBe(true);
    const backupText = createRunosDemoBackupText(
      {
        settings: createRunosDemoSettings(new Date("2026-07-10T00:00:00.000Z")),
        runLogs: getRunosRunLogsOrEmpty(adapter)
      },
      "2026-07-10T00:00:00.000Z"
    );

    const parsed = parseRunosDemoBackupText(backupText);
    expect(parsed.ok).toBe(true);

    const restoreStorage = new MemoryStorage();
    const restoreAdapter = createRunosStorageAdapter(restoreStorage);
    const result = restoreRunosDemoBackupText(adapter, backupText);
    const restoredToNewStorage = restoreRunosDemoBackupText(restoreAdapter, backupText);
    expect(result.status).toBe("restored");
    expect(restoredToNewStorage.status).toBe("restored");
    expect(storage.getItem(RUNOS_DEMO_SETTINGS_KEY)).toContain("runos-pwa-demo");
    expect(restoreStorage.getItem(RUNOS_DEMO_RUN_LOGS_KEY)).toContain("run-1");
    expect(describeRunosRestoreResult(result)).toContain("復元結果");
    expect(createRunosDemoBackupFileName(new Date("2026-07-10T00:00:00.000Z"))).toBe("runos-pwa-demo-backup-2026-07-10.json");
  });

  it("rejects corrupt backup JSON and appId mismatch", () => {
    const storage = new MemoryStorage();
    const adapter = createRunosStorageAdapter(storage);
    const corrupt = restoreRunosDemoBackupText(adapter, "{broken-json");
    const wanokuBackup = JSON.stringify({
      backupType: "runos-pwa-demo-data",
      appId: "wanoku-navi",
      schemaVersion: "runos-pwa-demo-data-v1",
      createdAt: "2026-07-10T00:00:00.000Z",
      data: {
        settings: createRunosDemoSettings(new Date("2026-07-10T00:00:00.000Z")),
        runLogs: []
      },
      checksum: {
        algorithm: "byte-length-and-char-sum-v1",
        bytes: 1,
        sum: 1
      }
    });
    const mismatch = restoreRunosDemoBackupText(adapter, wanokuBackup);

    expect(corrupt).toMatchObject({ status: "rejected", reason: "json-parse-failed" });
    expect(mismatch).toMatchObject({ status: "rejected", reason: "app-id-mismatch" });
    expect(storage.getItem(RUNOS_DEMO_SETTINGS_KEY)).toBeNull();
  });

  it("adds and deletes lightweight run logs using only demo keys", () => {
    const storage = new MemoryStorage();
    const adapter = createRunosStorageAdapter(storage);

    const added = addRunosRunLog(adapter, {
      id: "run-1",
      date: "2026-07-10",
      distanceKm: 10,
      durationSec: 2700,
      note: "tempo",
      painLevel: 2
    });

    expect(added.ok).toBe(true);
    expect(getRunosRunLogsOrEmpty(adapter)).toHaveLength(1);
    expect(storage.getItem(RUNOS_DEMO_RUN_LOGS_KEY)).toContain("tempo");
    expect(storage.getItem("meridian.v1")).toBeNull();

    const deleted = deleteRunosRunLog(adapter, "run-1");
    expect(deleted.status).toBe("success");
    expect(getRunosRunLogsOrEmpty(adapter)).toHaveLength(0);
  });

  it("includes settings and run logs in backup data", () => {
    const storage = new MemoryStorage();
    const adapter = createRunosStorageAdapter(storage);
    saveRunosRunLogs(adapter, [
      {
        id: "run-1",
        date: "2026-07-10",
        distanceKm: 5,
        durationSec: 1500,
        avgPace: 300,
        note: "easy"
      }
    ]);

    const data = loadRunosDemoBackupData(adapter);

    expect(data.settings.app).toBe("runos-pwa-demo");
    expect(data.runLogs).toHaveLength(1);
  });

  it("copies demo settings and run logs to the IndexedDB opt-in adapter without touching legacy keys", async () => {
    const storage = new MemoryStorage();
    const localAdapter = createRunosStorageAdapter(storage);
    const indexedDbAdapter = new MemoryAsyncJsonAdapter<typeof RUNOS_DEMO_SETTINGS_KEY | typeof RUNOS_DEMO_RUN_LOGS_KEY>();

    const added = addRunosRunLog(localAdapter, {
      id: "run-idb-1",
      date: "2026-07-10",
      distanceKm: 6,
      durationSec: 1800,
      note: "idb opt-in"
    });
    expect(added.ok).toBe(true);

    const saved = await saveRunosDemoToIndexedDb(indexedDbAdapter, localAdapter, new Date("2026-07-10T00:00:00.000Z"));
    const loaded = await loadRunosDemoFromIndexedDb(indexedDbAdapter, new Date("2026-07-10T00:01:00.000Z"));

    expect(saved.settingsResult.status).toBe("success");
    expect(saved.runLogsResult.status).toBe("success");
    expect(saved.runLogCount).toBe(1);
    expect(loaded.settingsResult.status).toBe("success");
    expect(loaded.runLogsResult.status).toBe("success");
    expect(loaded.runLogCount).toBe(1);
    expect(describeRunosIndexedDbSaveResult(saved)).toContain("保存先: IndexedDB");
    expect(describeRunosIndexedDbLoadResult(loaded)).toContain("件数: runLogs=1");
    expect(storage.getItem("meridian.v1")).toBeNull();
  });

  it("exports and restores IndexedDB opt-in backup JSON with a distinct backupType", async () => {
    const storage = new MemoryStorage();
    const localAdapter = createRunosStorageAdapter(storage);
    const sourceIndexedDb = new MemoryAsyncJsonAdapter<typeof RUNOS_DEMO_SETTINGS_KEY | typeof RUNOS_DEMO_RUN_LOGS_KEY>();
    const restoreIndexedDb = new MemoryAsyncJsonAdapter<typeof RUNOS_DEMO_SETTINGS_KEY | typeof RUNOS_DEMO_RUN_LOGS_KEY>();

    addRunosRunLog(localAdapter, {
      id: "run-idb-backup-1",
      date: "2026-07-10",
      distanceKm: 8,
      durationSec: 2400,
      note: "idb backup"
    });
    await saveRunosDemoToIndexedDb(sourceIndexedDb, localAdapter, new Date("2026-07-10T00:00:00.000Z"));

    const exported = await exportRunosIndexedDbDemoBackupText(sourceIndexedDb, new Date("2026-07-10T00:02:00.000Z"));
    expect(exported.status).toBe("exported");
    if (exported.status !== "exported") throw new Error("IndexedDB backup export failed in test.");
    expect(exported.backup.backupType).toBe(RUNOS_INDEXEDDB_BACKUP_TYPE);
    expect(exported.backup.backupType).not.toBe(RUNOS_DEMO_BACKUP_TYPE);
    expect(exported.backup.schemaVersion).toBe(RUNOS_INDEXEDDB_BACKUP_SCHEMA_VERSION);
    expect(describeRunosIndexedDbBackupExportResult(exported)).toContain("runLogs=1");

    const parsed = parseRunosIndexedDbDemoBackupText(exported.backupText);
    expect(parsed.ok).toBe(true);

    const restored = await restoreRunosIndexedDbDemoBackupText(restoreIndexedDb, exported.backupText);
    const loaded = await loadRunosDemoFromIndexedDb(restoreIndexedDb);

    expect(restored.status).toBe("restored");
    expect(describeRunosIndexedDbRestoreResult(restored)).toContain("runLogs=1");
    expect(loaded.runLogCount).toBe(1);
  });

  it("rejects localStorage backup and checksum mismatch for IndexedDB restore", async () => {
    const indexedDbAdapter = new MemoryAsyncJsonAdapter<typeof RUNOS_DEMO_SETTINGS_KEY | typeof RUNOS_DEMO_RUN_LOGS_KEY>();
    const localBackup = createRunosDemoBackupText(
      {
        settings: createRunosDemoSettings(new Date("2026-07-10T00:00:00.000Z")),
        runLogs: []
      },
      "2026-07-10T00:00:00.000Z"
    );
    const localBackupResult = await restoreRunosIndexedDbDemoBackupText(indexedDbAdapter, localBackup);
    expect(localBackupResult).toMatchObject({ status: "rejected", reason: "backup-type-mismatch" });

    const idbBackup = createRunosIndexedDbDemoBackupText(
      {
        settings: createRunosDemoSettings(new Date("2026-07-10T00:00:00.000Z")),
        runLogs: []
      },
      "2026-07-10T00:00:00.000Z"
    );
    const badChecksumJson = JSON.parse(idbBackup) as { checksum: { sum: number } };
    badChecksumJson.checksum.sum += 1;
    const badChecksum = JSON.stringify(badChecksumJson);
    const checksumResult = await restoreRunosIndexedDbDemoBackupText(indexedDbAdapter, badChecksum);
    expect(checksumResult).toMatchObject({ status: "rejected", reason: "checksum-mismatch" });
  });

  it("keeps lightweight run log storage mode on localStorage by default", async () => {
    const storage = new MemoryStorage();
    const localAdapter = createRunosStorageAdapter(storage);
    const indexedDbAdapter = new MemoryAsyncJsonAdapter<typeof RUNOS_DEMO_SETTINGS_KEY | typeof RUNOS_DEMO_RUN_LOGS_KEY>();

    const result = await addRunosRunLogForMode(
      "localStorage",
      localAdapter,
      indexedDbAdapter,
      {
        id: "run-mode-local",
        date: "2026-07-10",
        distanceKm: 5,
        durationSec: 1500
      },
      new Date("2026-07-10T00:03:00.000Z")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("run log mode save failed in test.");
    expect(result.saveResult.status).toBe("success");
    expect(result.saveResult.canonicalSource).toBe("localStorage");
    expect(storage.getItem(RUNOS_DEMO_RUN_LOGS_KEY)).toContain("run-mode-local");
    expect(indexedDbAdapter.values.size).toBe(0);
    expect(describeRunosLogStorageModeSaveResult(result.saveResult)).toContain("正本: localStorage");
  });

  it("can save lightweight run logs to indexedDB mode without writing localStorage", async () => {
    const storage = new MemoryStorage();
    const localAdapter = createRunosStorageAdapter(storage);
    const indexedDbAdapter = new MemoryAsyncJsonAdapter<typeof RUNOS_DEMO_SETTINGS_KEY | typeof RUNOS_DEMO_RUN_LOGS_KEY>();

    const result = await addRunosRunLogForMode(
      "indexedDB",
      localAdapter,
      indexedDbAdapter,
      {
        id: "run-mode-idb",
        date: "2026-07-10",
        distanceKm: 5,
        durationSec: 1500
      },
      new Date("2026-07-10T00:04:00.000Z")
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("run log idb mode save failed in test.");
    expect(result.saveResult.status).toBe("success");
    expect(result.saveResult.canonicalSource).toBe("indexedDB");
    expect(storage.getItem(RUNOS_DEMO_RUN_LOGS_KEY)).toBeNull();
    expect(indexedDbAdapter.values.get(RUNOS_DEMO_RUN_LOGS_KEY)).toContain("run-mode-idb");
  });

  it("does not treat dual-write as success when indexedDB fails", async () => {
    const storage = new MemoryStorage();
    const localAdapter = createRunosStorageAdapter(storage);
    const failingIndexedDb = new FailingAsyncJsonAdapter<typeof RUNOS_DEMO_SETTINGS_KEY | typeof RUNOS_DEMO_RUN_LOGS_KEY>();

    const result = await saveRunosRunLogsForMode(
      "dual-write",
      localAdapter,
      failingIndexedDb,
      [
        {
          id: "run-mode-dual",
          date: "2026-07-10",
          distanceKm: 5,
          durationSec: 1500,
          avgPace: 300,
          note: ""
        }
      ],
      new Date("2026-07-10T00:05:00.000Z")
    );

    expect(result.status).toBe("partial");
    expect(result.canonicalSource).toBe("localStorage");
    expect(result.failedTargets).toEqual(["indexedDB"]);
    expect(storage.getItem(RUNOS_DEMO_RUN_LOGS_KEY)).toContain("run-mode-dual");
    expect(describeRunosLogStorageModeSaveResult(result)).toContain("失敗先: indexedDB");
  });
});
