import type { UsageRecord } from "../../src/metering/record.ts";
import type { InsertOutcome, OrgHour, Rejection, UsageStore } from "../../src/metering/usage-store.ts";

/** In-memory UsageStore with switchable faults for handler tests. */
export class MemoryUsageStore implements UsageStore {
    readonly records = new Map<string, UsageRecord>();
    readonly dirty = new Set<string>();
    readonly rejected: Rejection[] = [];
    failInsert = false;
    failMarkDirty = false;
    failReject = false;
    failRecordIds = new Set<string>();

    async insert(records: readonly UsageRecord[]): Promise<InsertOutcome[]> {
        if (this.failInsert) throw new Error("connection reset");
        return records.map((r) => {
            if (this.failRecordIds.has(r._id)) return "failed";
            const existing = this.records.get(r._id);
            if (!existing) {
                this.records.set(r._id, r);
                return "inserted";
            }
            return existing.payloadHash === r.payloadHash ? "duplicate" : "conflict";
        });
    }

    async markDirty(keys: readonly OrgHour[]): Promise<void> {
        if (this.failMarkDirty) throw new Error("write concern timeout");
        for (const k of keys) this.dirty.add(`${k.orgId}|${k.hour.toISOString()}`);
    }

    async reject(rejections: readonly Rejection[]): Promise<void> {
        if (this.failReject) throw new Error("not primary");
        this.rejected.push(...rejections);
    }
}
