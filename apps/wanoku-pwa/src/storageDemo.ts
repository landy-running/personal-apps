import {
  LocalStorageAdapter,
  type LoadJsonResult,
  type LocalStorageLike,
  type SaveResult,
  type StorageMode
} from "@personal/storage";

export const WANOKU_DEMO_SETTINGS_KEY = "wanoku-pwa.demo.settings" as const;
export const WANOKU_DEMO_CORRUPT_JSON = "{broken-wanoku-demo-json";

export type WanokuDemoSettings = {
  app: "wanoku-pwa-demo";
  defaultFish: "シーバス";
  area: "東京湾奥";
  updatedAtIso: string;
};

export function createWanokuStorageAdapter(storage?: LocalStorageLike): LocalStorageAdapter<typeof WANOKU_DEMO_SETTINGS_KEY> {
  return new LocalStorageAdapter<typeof WANOKU_DEMO_SETTINGS_KEY>({
    app: "wanoku-navi",
    storage
  });
}

export function createWanokuDemoSettings(now = new Date()): WanokuDemoSettings {
  return {
    app: "wanoku-pwa-demo",
    defaultFish: "シーバス",
    area: "東京湾奥",
    updatedAtIso: now.toISOString()
  };
}

export function isWanokuDemoSettings(value: unknown): value is WanokuDemoSettings {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.app === "wanoku-pwa-demo" && record.defaultFish === "シーバス" && record.area === "東京湾奥" && typeof record.updatedAtIso === "string";
}

export function writeWanokuDemoCorruptJson(storage: LocalStorageLike): void {
  storage.setItem(WANOKU_DEMO_SETTINGS_KEY, WANOKU_DEMO_CORRUPT_JSON);
}

export function describeWanokuSaveResult(result: SaveResult<typeof WANOKU_DEMO_SETTINGS_KEY>): string {
  switch (result.status) {
    case "success":
      return `保存成功: key=${result.key}, mode=${result.mode}, size=${result.bytes} bytes`;
    case "memory":
      return `一時保存: key=${result.key}, mode=${result.mode}, reason=${result.reason}, size=${result.bytes ?? "unknown"} bytes`;
    case "blocked":
      return `保存停止: key=${result.key}, reason=${result.reason}, corruptBackup=${result.corruptBackup?.backupKey ?? "none"}`;
    case "failed":
      return `保存失敗: key=${result.key}, mode=${result.mode}, reason=${result.reason}, size=${result.bytes ?? "unknown"} bytes`;
    case "asyncAccepted":
      return `非同期保存受付: key=${result.key}, provider=${result.provider}, size=${result.bytes ?? "unknown"} bytes`;
  }
}

export function describeWanokuLoadResult(
  result: LoadJsonResult<typeof WANOKU_DEMO_SETTINGS_KEY, WanokuDemoSettings>,
  mode: StorageMode
): string {
  switch (result.status) {
    case "success":
      return `読込成功: key=${result.key}, mode=${result.mode}, adapterMode=${mode}, size=${result.bytes} bytes`;
    case "missing":
      return `未保存: key=${result.key}, mode=${result.mode}, adapterMode=${mode}`;
    case "corrupt":
      return `破損検知: key=${result.key}, backup=${result.corruptBackup.backupKey}, archive=${result.corruptBackup.archiveStatus}`;
    case "failed":
      return `読込失敗: key=${result.key}, mode=${result.mode}, reason=${result.reason}`;
  }
}

