import { describe, expect, it } from "vitest";
import {
  RUNOS_DEMO_SETTINGS_KEY,
  createRunosDemoBackupText,
  createRunosDemoBackupFileName,
  createRunosDemoSettings,
  createRunosStorageAdapter,
  describeRunosLoadResult,
  describeRunosRestoreResult,
  describeRunosSaveResult,
  isRunosDemoSettings,
  parseRunosDemoBackupText,
  restoreRunosDemoBackupText,
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
    const backupText = createRunosDemoBackupText(createRunosDemoSettings(new Date("2026-07-10T00:00:00.000Z")), "2026-07-10T00:00:00.000Z");

    const parsed = parseRunosDemoBackupText(backupText);
    expect(parsed.ok).toBe(true);

    const result = restoreRunosDemoBackupText(adapter, backupText);
    expect(result.status).toBe("success");
    expect(storage.getItem(RUNOS_DEMO_SETTINGS_KEY)).toContain("runos-pwa-demo");
    expect(describeRunosRestoreResult(result)).toContain("復元結果");
    expect(createRunosDemoBackupFileName(new Date("2026-07-10T00:00:00.000Z"))).toBe("runos-pwa-demo-backup-2026-07-10.json");
  });

  it("rejects corrupt backup JSON and appId mismatch", () => {
    const storage = new MemoryStorage();
    const adapter = createRunosStorageAdapter(storage);
    const corrupt = restoreRunosDemoBackupText(adapter, "{broken-json");
    const wanokuBackup = JSON.stringify({
      backupType: "runos-pwa-demo-settings",
      appId: "wanoku-navi",
      schemaVersion: "runos-pwa-demo-settings-v1",
      createdAt: "2026-07-10T00:00:00.000Z",
      data: createRunosDemoSettings(new Date("2026-07-10T00:00:00.000Z")),
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
});
