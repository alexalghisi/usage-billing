import type { Database } from "../infra/mongo.ts";
import { MongoUsageStore } from "../metering/mongo-usage-store.ts";
import type { OrgHour } from "../metering/usage-store.ts";

/**
 * Flags every org-hour with raw records in the range for recomputation. Used
 * after a bulk import of historical usage, or after changing how rollups are
 * built. The aggregator does the actual work, so a backfill and normal
 * ingestion can run at the same time.
 */
export async function backfill(db: Database, range: { from: Date; to: Date; orgId?: string }): Promise<number> {
    const cursor = db.usageRecords.aggregate<{ _id: OrgHour }>([
        { $match: { ...(range.orgId ? { orgId: range.orgId } : {}), hour: { $gte: range.from, $lt: range.to } } },
        { $group: { _id: { orgId: "$orgId", hour: "$hour" } } },
    ]);
    const store = new MongoUsageStore(db);
    let batch: OrgHour[] = [];
    let total = 0;
    for await (const doc of cursor) {
        batch.push(doc._id);
        if (batch.length === 1000) {
            await store.markDirty(batch);
            total += batch.length;
            batch = [];
        }
    }
    await store.markDirty(batch);
    return total + batch.length;
}
