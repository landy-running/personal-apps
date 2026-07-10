import { describe, expect, it } from "vitest";
import {
  LocalStorageAdapter,
  archiveCorruptValue,
  createCorruptBackupKey,
  type LocalStorageLike
} from "./index";

class MemoryStorage implements LocalStorageLike {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FailingWriteStorage extends MemoryStorage {
  setItem(): void {
    throw new Error("quota exceeded");
  }
}

class FailingReadStorage extends MemoryStorage {
  getItem(): string | null {
    throw new Error("read failed");
  }
}

describe("LocalStorageAdapter", () => {
  it("saves JSON to local storage and returns the serialized size", () => {
    const storage = new MemoryStorage();
    const adapter = new LocalStorageAdapter<"meridian.v1">({
      app: "runos",
      storage
    });

    const result = adapter.saveJson("meridian.v1", { activities: [], wellness: [] });

    expect(result.status).toBe("success");
    expect(result.mode).toBe("local");
    if (result.status === "success") {
      expect(result.bytes).toBeGreaterThan(0);
    }
    expect(storage.getItem("meridian.v1")).toBe('{"activities":[],"wellness":[]}');
  });

  it("falls back to memory mode when localStorage writes fail", () => {
    const adapter = new LocalStorageAdapter<"logs">({
      app: "wanoku-navi",
      storage: new FailingWriteStorage()
    });

    const saveResult = adapter.saveJson("logs", [{ id: "log-1" }]);

    expect(saveResult.status).toBe("memory");
    expect(saveResult.mode).toBe("memory");
    if (saveResult.status === "memory") {
      expect(saveResult.reason).toBe("write-failed");
    }
    expect(adapter.mode).toBe("memory");

    const loadResult = adapter.loadJson("logs", Array.isArray);
    expect(loadResult.status).toBe("success");
    if (loadResult.status === "success") {
      expect(loadResult.value).toEqual([{ id: "log-1" }]);
    }
  });

  it("detects JSON parse failure, archives the raw value, and blocks later writes for that key", () => {
    const storage = new MemoryStorage();
    storage.setItem("meridian.v1", "{broken-json");
    const adapter = new LocalStorageAdapter<"meridian.v1">({
      app: "runos",
      storage,
      now: () => 1783600000000
    });

    const loadResult = adapter.loadJson("meridian.v1");

    expect(loadResult.status).toBe("corrupt");
    if (loadResult.status === "corrupt") {
      expect(loadResult.corruptBackup.backupKey).toBe("meridian.v1.corrupt.1783600000000");
      expect(loadResult.corruptBackup.archiveStatus).toBe("archived");
      expect(storage.getItem("meridian.v1.corrupt.1783600000000")).toBe("{broken-json");
    }

    const saveResult = adapter.saveJson("meridian.v1", { activities: [], wellness: [] });

    expect(saveResult.status).toBe("blocked");
    if (saveResult.status === "blocked") {
      expect(saveResult.blockedKeys).toEqual(["meridian.v1"]);
    }
    expect(storage.getItem("meridian.v1")).toBe("{broken-json");
  });

  it("allows explicit overwrite after a corrupt lock", () => {
    const storage = new MemoryStorage();
    storage.setItem("logs", "{broken-json");
    const adapter = new LocalStorageAdapter<"logs">({
      app: "wanoku-navi",
      storage,
      now: () => 1783600000004
    });

    const corrupt = adapter.loadJson("logs", Array.isArray);
    expect(corrupt.status).toBe("corrupt");

    adapter.allowOverwrite("logs");
    const restored = adapter.saveJson("logs", []);

    expect(restored.status).toBe("success");
    expect(storage.getItem("logs")).toBe("[]");
  });

  it("archives required-shape failures with the generic <key>.corrupt.<timestamp> pattern", () => {
    const storage = new MemoryStorage();
    storage.setItem("logs", "{}");
    const adapter = new LocalStorageAdapter<"logs">({
      app: "wanoku-navi",
      storage,
      now: () => 1783600000001
    });

    const result = adapter.loadJson("logs", Array.isArray);

    expect(result.status).toBe("corrupt");
    if (result.status === "corrupt") {
      expect(result.corruptBackup.reason).toBe("required-shape-missing");
      expect(result.corruptBackup.backupKey).toBe("logs.corrupt.1783600000001");
      expect(storage.getItem("logs.corrupt.1783600000001")).toBe("{}");
    }
  });

  it("returns archive-failed when corrupt backup storage write fails", () => {
    const info = archiveCorruptValue({
      app: "wanoku-navi",
      sourceKey: "settings",
      rawValue: "{bad",
      timestamp: 1783600000002,
      reason: "json-parse-failed",
      storage: new FailingWriteStorage()
    });

    expect(info.backupKey).toBe("settings.corrupt.1783600000002");
    expect(info.archiveStatus).toBe("archive-failed");
    expect(info.rawValueAvailable).toBe(true);
  });

  it("returns read-failed and enters memory mode when localStorage reads fail", () => {
    const adapter = new LocalStorageAdapter<"settings">({
      app: "wanoku-navi",
      storage: new FailingReadStorage()
    });

    const result = adapter.loadJson("settings");

    expect(result.status).toBe("failed");
    expect(result.mode).toBe("memory");
    expect(adapter.mode).toBe("memory");
  });

  it("exposes corrupt backup key creation for callers that need to log planned keys", () => {
    expect(createCorruptBackupKey("logs", 1783600000003)).toBe("logs.corrupt.1783600000003");
  });
});
