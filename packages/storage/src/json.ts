export type JsonStringifyResult =
  | {
      ok: true;
      json: string;
      bytes: number;
    }
  | {
      ok: false;
      error: unknown;
    };

export function estimateUtf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export function safeJsonStringify(value: unknown): JsonStringifyResult {
  try {
    const json = JSON.stringify(value);
    return {
      ok: true,
      json,
      bytes: estimateUtf8Bytes(json)
    };
  } catch (error) {
    return {
      ok: false,
      error
    };
  }
}

