import { describe, expect, it } from "vitest";
import {
  RUNOS_DEMO_SETTINGS_KEY,
  createRunosDemoSettings,
  createRunosStorageAdapter,
  describeRunosLoadResult,
  describeRunosSaveResult,
  isRunosDemoSettings,
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
});

