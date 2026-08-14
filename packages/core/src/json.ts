export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonSchema = Readonly<Record<string, unknown>>;

export function stringifyJson(value: unknown): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (typeof nestedValue === "bigint") {
        throw new TypeError("BigInt values are not JSON serializable");
      }
      return nestedValue;
    });
  } catch (error) {
    // JSON.stringify detects true cycles natively; shared non-circular
    // references are valid JSON and must not be rejected here.
    if (error instanceof TypeError && /circular/iu.test(error.message)) {
      throw new TypeError("Circular values are not JSON serializable");
    }
    throw error;
  }

  if (serialized === undefined) {
    throw new TypeError("Value is not JSON serializable");
  }

  return serialized;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
