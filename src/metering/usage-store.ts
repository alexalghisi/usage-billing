import type { UsageRecord } from "./record.ts";

export type InsertOutcome = "inserted" | "duplicate" | "conflict" | "failed";

export interface Rejection {
    messageId: string;
    reason: string;
    payload: string;
    rejectedAt: Date;
}

export interface OrgHour {
    orgId: string;
    hour: Date;
}

/** Persistence port for the ingestion handler. */
export interface UsageStore {
    /** One outcome per input record, in order. Must be idempotent on record id. */
    insert(records: readonly UsageRecord[]): Promise<InsertOutcome[]>;
    /** Flags org-hours whose rollups must be recomputed. */
    markDirty(keys: readonly OrgHour[]): Promise<void>;
    reject(rejections: readonly Rejection[]): Promise<void>;
}
