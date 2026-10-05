import { createHash } from "node:crypto";

/** Deterministic JSON: sorted keys, bigint as decimal string, dates as ISO strings. */
export function canonicalJson(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (value instanceof Date) return JSON.stringify(value.toISOString());
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}
