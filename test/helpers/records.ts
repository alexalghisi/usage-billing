import type { Meter } from "../../src/domain/meters.ts";
import type { Clock } from "../../src/domain/time.ts";
import type { Database } from "../../src/infra/mongo.ts";
import { MongoUsageStore } from "../../src/metering/mongo-usage-store.ts";
import { validateRecord, type UsageRecord } from "../../src/metering/record.ts";

let seq = 0;

export function usage(orgId: string, meter: Meter, quantity: string, timestamp: string, clock: Clock, serviceId = "svc_1"): UsageRecord {
    const result = validateRecord({ eventId: `t-${++seq}`, orgId, serviceId, meter, quantity, timestamp }, clock);
    if (!result.ok) throw new Error(result.reason);
    return result.record;
}

/** Writes records the way the ingestion handler does: insert, then flag the hours. */
export async function ingest(db: Database, records: UsageRecord[], markDirty = true): Promise<void> {
    const store = new MongoUsageStore(db);
    await store.insert(records);
    if (markDirty) await store.markDirty(records.map((r) => ({ orgId: r.orgId, hour: r.hour })));
}
