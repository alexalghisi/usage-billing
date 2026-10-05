import type { Database } from "../infra/mongo.ts";
import { MongoUsageStore } from "../metering/mongo-usage-store.ts";
import type { OrgHour } from "../metering/usage-store.ts";

export interface Mismatch {
    orgId: string;
    serviceId: string;
    meter: string;
    bucket: Date;
    level: "hourly" | "daily";
    expected: bigint;
    actual: bigint;
}

export interface ReconcileReport {
    from: Date;
    to: Date;
    rawRecords: number;
    rawQuantity: bigint;
    hourlyBucketsChecked: number;
    dailyBucketsChecked: number;
    mismatches: Mismatch[];
    repairedHours: number;
}

interface Bucket {
    _id: { orgId: string; serviceId: string; meter: string; bucket: Date };
    quantity: bigint;
    count?: number;
}

function key(b: Bucket["_id"]): string {
    return `${b.orgId}|${b.serviceId}|${b.meter}|${b.bucket.toISOString()}`;
}

function compare(level: Mismatch["level"], expected: Bucket[], actual: Bucket[]): Mismatch[] {
    const actualByKey = new Map(actual.map((b) => [key(b._id), b]));
    const out: Mismatch[] = [];
    for (const e of expected) {
        const a = actualByKey.get(key(e._id));
        actualByKey.delete(key(e._id));
        const actualQty = a ? BigInt(a.quantity) : 0n;
        if (BigInt(e.quantity) !== actualQty) out.push({ ...e._id, level, expected: BigInt(e.quantity), actual: actualQty });
    }
    // Rollups with no raw records behind them.
    for (const a of actualByKey.values()) if (BigInt(a.quantity) !== 0n) out.push({ ...a._id, level, expected: 0n, actual: BigInt(a.quantity) });
    return out;
}

/**
 * Recomputes usage from raw records and compares it with both rollup levels.
 * It reads independently of the aggregator's code path, so a bug there (or a
 * lost dirty marker) shows up here as a mismatch. Day boundaries must be UTC midnights.
 */
export async function reconcile(db: Database, range: { from: Date; to: Date; orgId?: string; repair?: boolean }): Promise<ReconcileReport> {
    const org = range.orgId ? { orgId: range.orgId } : {};
    const rawHourly = await db.usageRecords
        .aggregate<Bucket>([
            { $match: { ...org, hour: { $gte: range.from, $lt: range.to } } },
            { $group: { _id: { orgId: "$orgId", serviceId: "$serviceId", meter: "$meter", bucket: "$hour" }, quantity: { $sum: "$quantity" }, count: { $sum: 1 } } },
        ])
        .toArray();
    const hourly = await db.hourlyRollups
        .aggregate<Bucket>([
            { $match: { ...org, hour: { $gte: range.from, $lt: range.to } } },
            { $project: { _id: { orgId: "$orgId", serviceId: "$serviceId", meter: "$meter", bucket: "$hour" }, quantity: 1 } },
        ])
        .toArray();
    const rawDaily = await db.usageRecords
        .aggregate<Bucket>([
            { $match: { ...org, hour: { $gte: range.from, $lt: range.to } } },
            {
                $group: {
                    _id: { orgId: "$orgId", serviceId: "$serviceId", meter: "$meter", bucket: { $dateTrunc: { date: "$hour", unit: "day" } } },
                    quantity: { $sum: "$quantity" },
                },
            },
        ])
        .toArray();
    const daily = await db.dailyRollups
        .aggregate<Bucket>([
            { $match: { ...org, day: { $gte: range.from, $lt: range.to } } },
            { $project: { _id: { orgId: "$orgId", serviceId: "$serviceId", meter: "$meter", bucket: "$day" }, quantity: 1 } },
        ])
        .toArray();

    const mismatches = [...compare("hourly", rawHourly, hourly), ...compare("daily", rawDaily, daily)];
    let repairedHours = 0;
    if (range.repair && mismatches.length > 0) {
        const hours = new Map<string, OrgHour>();
        // Flagging any hour of a day also rebuilds that day's rollup, so a daily-only mismatch flags midnight.
        for (const m of mismatches) hours.set(`${m.orgId}|${m.bucket.getTime()}`, { orgId: m.orgId, hour: m.bucket });
        await new MongoUsageStore(db).markDirty([...hours.values()]);
        repairedHours = hours.size;
    }
    return {
        from: range.from,
        to: range.to,
        rawRecords: rawHourly.reduce((n, b) => n + (b.count ?? 0), 0),
        rawQuantity: rawHourly.reduce((n, b) => n + BigInt(b.quantity), 0n),
        hourlyBucketsChecked: rawHourly.length,
        dailyBucketsChecked: rawDaily.length,
        mismatches,
        repairedHours,
    };
}
