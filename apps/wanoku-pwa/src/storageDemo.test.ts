import { describe, expect, it } from "vitest";
import {
  WANOKU_DEMO_SETTINGS_KEY,
  createWanokuDemoSettings,
  createWanokuStorageAdapter,
  describeWanokuLoadResult,
  describeWanokuSaveResult,
  isWanokuDemoSettings,
  writeWanokuDemoCorruptJson
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
});

