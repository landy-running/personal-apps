import { describe, expect, it } from "vitest";
import {
  RUNOS_DEMO_RUN_LOGS_KEY,
  RUNOS_DEMO_SETTINGS_KEY,
  addRunosRunLog,
  createRunosDemoBackupText,
  createRunosDemoBackupFileName,
  createRunosDemoSettings,
  createRunosStorageAdapter,
  deleteRunosRunLog,
  describeRunosLoadResult,
  describeRunosRestoreResult,
  describeRunosSaveResult,
  getRunosRunLogsOrEmpty,
  isRunosDemoSettings,
  loadRunosDemoBackupData,
  parseRunosDemoBackupText,
  restoreRunosDemoBackupText,
  saveRunosRunLogs,
  writeRunosDemoCorruptJson
} from "./storageDemo";
import type { LocalStorageLike } from "@personal/storage";

class MemoryStorage implements LocalStorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
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
});
