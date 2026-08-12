export type JsonObject = Record<string, unknown>;

export function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parseJsonObject(source: string | undefined): JsonObject | null {
  if (!source) return null;
  try {
    const parsed: unknown = JSON.parse(source);
    return asObject(parsed);
  } catch {
    return null;
  }
}
