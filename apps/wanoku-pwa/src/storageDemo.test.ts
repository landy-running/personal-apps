import { describe, expect, it } from "vitest";
import {
  WANOKU_DEMO_CATCH_LOGS_KEY,
  WANOKU_DEMO_SETTINGS_KEY,
  addWanokuCatchLog,
  createWanokuDemoBackupText,
  createWanokuDemoSettings,
  createWanokuStorageAdapter,
  deleteWanokuCatchLog,
  describeWanokuIndexedDbLoadResult,
  describeWanokuIndexedDbSaveResult,
  describeWanokuLoadResult,
  describeWanokuRestoreResult,
  describeWanokuSaveResult,
  getWanokuCatchLogsOrEmpty,
  isWanokuDemoSettings,
  loadWanokuDemoFromIndexedDb,
  loadWanokuDemoBackupData,
  restoreWanokuDemoBackupText,
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
});
