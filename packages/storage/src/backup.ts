import { type AppId } from "./contracts";
import { estimateUtf8Bytes } from "./json";

export type BackupChecksum = {
  algorithm: "byte-length-and-char-sum-v1";
  bytes: number;
  sum: number;
};

export type BackupJson<TData = unknown, TBackupType extends string = string> = {
  backupType: TBackupType;
  appId: AppId;
  schemaVersion: string;
  createdAt: string;
  data: TData;
  checksum: BackupChecksum;
};

export type CreateBackupJsonOptions<TData, TBackupType extends string> = {
  backupType: TBackupType;
  appId: AppId;
  schemaVersion: string;
  createdAt?: string;
  data: TData;
};

export type ParseBackupJsonOptions<TData, TBackupType extends string> = {
  text: string;
  expectedBackupType: TBackupType;
  expectedAppId: AppId;
  expectedSchemaVersion?: string;
  validateData: (value: unknown) => value is TData;
};

export type ParseBackupJsonResult<TData, TBackupType extends string> =
  | {
      ok: true;
      backup: BackupJson<TData, TBackupType>;
    }
  | {
      ok: false;
      reason:
        | "json-parse-failed"
        | "invalid-shape"
        | "backup-type-mismatch"
        | "app-id-mismatch"
        | "schema-version-mismatch"
        | "checksum-mismatch"
        | "data-validation-failed";
      message: string;
    };

export function createBackupJson<TData, TBackupType extends string>(
  options: CreateBackupJsonOptions<TData, TBackupType>
): BackupJson<TData, TBackupType> {
  return {
    backupType: options.backupType,
    appId: options.appId,
    schemaVersion: options.schemaVersion,
    createdAt: options.createdAt ?? new Date().toISOString(),
    data: options.data,
    checksum: createBackupChecksum(options.data)
  };
}

export function stringifyBackupJson<TData, TBackupType extends string>(
  backup: BackupJson<TData, TBackupType>
): string {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

export function parseBackupJson<TData, TBackupType extends string>(
  options: ParseBackupJsonOptions<TData, TBackupType>
): ParseBackupJsonResult<TData, TBackupType> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.text);
  } catch {
    return {
      ok: false,
      reason: "json-parse-failed",
      message: "バックアップJSONを解析できません。"
    };
  }

  if (!isBackupJsonShape(parsed)) {
    return {
      ok: false,
      reason: "invalid-shape",
      message: "バックアップJSONの必須項目が不足しています。"
    };
  }

  if (parsed.backupType !== options.expectedBackupType) {
    return {
      ok: false,
      reason: "backup-type-mismatch",
      message: `backupTypeが一致しません: ${parsed.backupType}`
    };
  }

  if (parsed.appId !== options.expectedAppId) {
    return {
      ok: false,
      reason: "app-id-mismatch",
      message: `appIdが一致しません: ${parsed.appId}`
    };
  }

  if (options.expectedSchemaVersion && parsed.schemaVersion !== options.expectedSchemaVersion) {
    return {
      ok: false,
      reason: "schema-version-mismatch",
      message: `schemaVersionが一致しません: ${parsed.schemaVersion}`
    };
  }

  if (!verifyBackupChecksum(parsed.data, parsed.checksum)) {
    return {
      ok: false,
      reason: "checksum-mismatch",
      message: "バックアップJSONの簡易検証に失敗しました。"
    };
  }

  if (!options.validateData(parsed.data)) {
    return {
      ok: false,
      reason: "data-validation-failed",
      message: "バックアップdataの形式が、このPWAのdemo設定と一致しません。"
    };
  }

  return {
    ok: true,
    backup: parsed as BackupJson<TData, TBackupType>
  };
}

export function createBackupChecksum(value: unknown): BackupChecksum {
  const json = JSON.stringify(value);
  let sum = 0;
  for (let index = 0; index < json.length; index += 1) {
    sum = (sum + json.charCodeAt(index)) % 1_000_000_007;
  }

  return {
    algorithm: "byte-length-and-char-sum-v1",
    bytes: estimateUtf8Bytes(json),
    sum
  };
}

export function verifyBackupChecksum(value: unknown, checksum: BackupChecksum): boolean {
  const expected = createBackupChecksum(value);
  return checksum.algorithm === expected.algorithm && checksum.bytes === expected.bytes && checksum.sum === expected.sum;
}

function isBackupJsonShape(value: unknown): value is BackupJson {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.backupType === "string" &&
    typeof record.appId === "string" &&
    typeof record.schemaVersion === "string" &&
    typeof record.createdAt === "string" &&
    "data" in record &&
    isBackupChecksum(record.checksum)
  );
}

function isBackupChecksum(value: unknown): value is BackupChecksum {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.algorithm === "byte-length-and-char-sum-v1" && typeof record.bytes === "number" && typeof record.sum === "number";
}

