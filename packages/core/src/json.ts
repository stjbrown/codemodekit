export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type JsonObject = { readonly [key: string]: JsonValue };

export type JsonSchema = Readonly<Record<string, unknown>>;

export function stringifyJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (typeof nestedValue === "bigint") {
      throw new TypeError("BigInt values are not JSON serializable");
    }

    if (typeof nestedValue === "object" && nestedValue !== null) {
      if (seen.has(nestedValue)) {
        throw new TypeError("Circular values are not JSON serializable");
      }
      seen.add(nestedValue);
    }

    return nestedValue;
  });

  if (serialized === undefined) {
    throw new TypeError("Value is not JSON serializable");
  }

  return serialized;
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
