import { describe, expect, it } from "vitest";
import {
  RUNOS_PRIMARY_STORAGE_KEY,
  RUNOS_STORAGE_CONTRACT,
  WANOKU_STORAGE_CONTRACT,
  WANOKU_STORAGE_KEYS,
  createRunosCorruptBackupKey,
  createWanokuCorruptBackupKey,
  estimateUtf8Bytes,
  isRunosCorruptBackupKey,
  isWanokuCorruptBackupKey,
  isWanokuStorageKey,
  safeJsonStringify,
  type BackupManifest,
  type CorruptBackupInfo,
  type SaveResult
} from "./index";

describe("storage contracts", () => {
  it("represents RunOS primary and corrupt storage keys", () => {
    expect(RUNOS_PRIMARY_STORAGE_KEY).toBe("meridian.v1");
    expect(RUNOS_STORAGE_CONTRACT.lockScope).toBe("app");
    expect(createRunosCorruptBackupKey(1783600000000)).toBe("meridian.v1.corrupt.1783600000000");
    expect(isRunosCorruptBackupKey("meridian.v1.corrupt.1783600000000")).toBe(true);
    expect(isRunosCorruptBackupKey("meridian.v1")).toBe(false);
  });

  it("represents wanoku multi-key storage and key-level corrupt locks", () => {
    expect(WANOKU_STORAGE_KEYS).toContain("logs");
    expect(WANOKU_STORAGE_KEYS).toContain("settings");
    expect(WANOKU_STORAGE_CONTRACT.lockScope).toBe("key");
    expect(WANOKU_STORAGE_CONTRACT.multiKeyWritesAreTransactional).toBe(false);
    expect(createWanokuCorruptBackupKey("logs", 1783600000000)).toBe("logs.corrupt.1783600000000");
    expect(isWanokuStorageKey("logs")).toBe(true);
    expect(isWanokuStorageKey("meridian.v1")).toBe(false);
    expect(isWanokuCorruptBackupKey("settings.corrupt.1783600000000")).toBe(true);
  });

  it("keeps SaveResult states explicit enough for current notification rules", () => {
    const success = {
      status: "success",
      mode: "local",
      key: "meridian.v1",
      bytes: 128
    } satisfies SaveResult<"meridian.v1">;

    const memory = {
      status: "memory",
      mode: "memory",
      key: "logs",
      reason: "write-failed"
    } satisfies SaveResult<"logs">;

    const blocked = {
      status: "blocked",
      mode: "blocked",
      key: "logs",
      blockedKeys: ["logs"],
      reason: "corrupt-lock"
    } satisfies SaveResult<"logs">;

    const asyncAccepted = {
      status: "asyncAccepted",
      mode: "async-pending",
      key: "settings",
      provider: "window.storage"
    } satisfies SaveResult<"settings">;

    expect(success.status).toBe("success");
    expect(memory.status).toBe("memory");
    expect(blocked.status).toBe("blocked");
    expect(asyncAccepted.status).toBe("asyncAccepted");
  });

  it("represents corrupt backup metadata and normal backup manifests", () => {
    const corruptInfo = {
      app: "wanoku-navi",
      sourceKey: "logs",
      backupKey: "logs.corrupt.1783600000000",
      timestamp: 1783600000000,
      detectedAtIso: "2026-07-10T00:00:00.000Z",
      reason: "json-parse-failed",
      archiveStatus: "archived",
      rawValueAvailable: true,
      exportFileName: "wanoku-corrupt-logs-2026-07-10T00-00-00.000Z.txt"
    } satisfies CorruptBackupInfo<"logs">;

    const manifest = {
      app: "runos",
      kind: "normal-json",
      createdAtIso: "2026-07-10T00:00:00.000Z",
      fileName: "runos-backup-2026-07-10.json",
      source: "memory",
      keys: ["meridian.v1"],
      formatVersion: "legacy-localStorage-v1",
      includesCorruptRaw: false
    } satisfies BackupManifest<"meridian.v1">;

    expect(corruptInfo.backupKey).toBe("logs.corrupt.1783600000000");
    expect(manifest.keys).toEqual(["meridian.v1"]);
  });

  it("keeps JSON helpers independent from browser storage implementations", () => {
    const json = safeJsonStringify({ message: "湾奥" });

    expect(json.ok).toBe(true);
    if (json.ok) {
      expect(json.json).toBe('{"message":"湾奥"}');
      expect(json.bytes).toBe(estimateUtf8Bytes(json.json));
    }
  });
});
