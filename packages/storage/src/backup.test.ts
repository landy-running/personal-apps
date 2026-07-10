import { describe, expect, it } from "vitest";
import { createBackupJson, parseBackupJson, stringifyBackupJson } from "./backup";

const demoData = {
  app: "runos-pwa-demo",
  distanceUnit: "km",
  paceFormat: "min/km",
  updatedAtIso: "2026-07-10T00:00:00.000Z"
};

function isDemoData(value: unknown): value is typeof demoData {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.app === "runos-pwa-demo" && record.distanceUnit === "km" && record.paceFormat === "min/km" && typeof record.updatedAtIso === "string";
}

describe("backup JSON utilities", () => {
  it("creates and parses a backup envelope with checksum", () => {
    const backup = createBackupJson({
      backupType: "demo-settings",
      appId: "runos",
      schemaVersion: "demo-v1",
      createdAt: "2026-07-10T00:00:00.000Z",
      data: demoData
    });

    const parsed = parseBackupJson({
      text: stringifyBackupJson(backup),
      expectedBackupType: "demo-settings",
      expectedAppId: "runos",
      expectedSchemaVersion: "demo-v1",
      validateData: isDemoData
    });

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.backup.data).toEqual(demoData);
      expect(parsed.backup.checksum.bytes).toBeGreaterThan(0);
    }
  });

  it("rejects corrupt JSON", () => {
    const parsed = parseBackupJson({
      text: "{broken-json",
      expectedBackupType: "demo-settings",
      expectedAppId: "runos",
      expectedSchemaVersion: "demo-v1",
      validateData: isDemoData
    });

    expect(parsed).toMatchObject({
      ok: false,
      reason: "json-parse-failed"
    });
  });

  it("rejects appId mismatch", () => {
    const backup = createBackupJson({
      backupType: "demo-settings",
      appId: "wanoku-navi",
      schemaVersion: "demo-v1",
      createdAt: "2026-07-10T00:00:00.000Z",
      data: demoData
    });

    const parsed = parseBackupJson({
      text: stringifyBackupJson(backup),
      expectedBackupType: "demo-settings",
      expectedAppId: "runos",
      expectedSchemaVersion: "demo-v1",
      validateData: isDemoData
    });

    expect(parsed).toMatchObject({
      ok: false,
      reason: "app-id-mismatch"
    });
  });

  it("rejects checksum mismatch", () => {
    const backup = createBackupJson({
      backupType: "demo-settings",
      appId: "runos",
      schemaVersion: "demo-v1",
      createdAt: "2026-07-10T00:00:00.000Z",
      data: demoData
    });
    const tampered = stringifyBackupJson({
      ...backup,
      data: {
        ...demoData,
        paceFormat: "tampered"
      }
    });

    const parsed = parseBackupJson({
      text: tampered,
      expectedBackupType: "demo-settings",
      expectedAppId: "runos",
      expectedSchemaVersion: "demo-v1",
      validateData: isDemoData
    });

    expect(parsed).toMatchObject({
      ok: false,
      reason: "checksum-mismatch"
    });
  });
});
