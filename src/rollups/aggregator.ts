import type { AnyBulkWriteOperation } from "mongodb";
import type { Meter } from "../domain/meters.ts";
import { DAY_MS, startOfDay, type Clock } from "../domain/time.ts";
import { silentLogger, type Logger } from "../infra/logger.ts";
import type { Database } from "../infra/mongo.ts";
import type { OrgHour } from "../metering/usage-store.ts";
import { HOUR_CLOSE_GRACE_MS, rollupId, type DailyRollup, type HourlyRollup } from "./types.ts";

export interface AggregationResult {
    hours: number;
    days: number;
    /** Markers left in place because new records arrived while recomputing. */
    requeued: number;
}

interface HourGroup {
    _id: { orgId: string; hour: Date; serviceId: string; meter: Meter };
    quantity: bigint;
    recordCount: number;
    lateRecords: number;
}

interface DayGroup {
    _id: { orgId: string; day: Date; serviceId: string; meter: Meter };
    quantity: bigint;
    recordCount: number;
}

/**
 * Recomputes rollups for org-hours flagged by ingestion. Every rollup is
 * rebuilt from the raw records rather than incremented, so running twice,
 * crashing half-way or receiving data for an hour that closed days ago all
 * converge on the same numbers.
 */
export class Aggregator {
    private readonly db: Database;
    private readonly clock: Clock;
    private readonly logger: Logger;

    constructor(db: Database, clock: Clock, logger: Logger = silentLogger) {
        this.db = db;
        this.clock = clock;
        this.logger = logger;
    }

    async runOnce(limit = 5000): Promise<AggregationResult> {
        // Ordered by org and hour so one batch covers whole org-days and each day is rebuilt once.
        const markers = await this.db.dirtyHours.find({}).sort({ orgId: 1, hour: 1 }).limit(limit).toArray();
        if (markers.length === 0) return { hours: 0, days: 0, requeued: 0 };
        await this.recomputeHours(markers);
        const days = new Map<string, OrgHour>();
        for (const m of markers) {
            const day = startOfDay(m.hour);
            days.set(`${m.orgId}|${day.getTime()}`, { orgId: m.orgId, hour: day });
        }
        await this.recomputeDays([...days.values()]);

        // Compare-and-delete: a marker re-flagged during the recompute keeps its new token and survives.
        const res = await this.db.dirtyHours.bulkWrite(
            markers.map((m) => ({ deleteOne: { filter: { _id: m._id, token: m.token } } })),
            { ordered: false },
        );
        const requeued = markers.length - res.deletedCount;
        this.logger.info("rollups recomputed", { hours: markers.length, days: days.size, requeued });
        return { hours: markers.length, days: days.size, requeued };
    }

    /** Runs until no dirty hours are left. */
    async drain(): Promise<AggregationResult> {
        const total: AggregationResult = { hours: 0, days: 0, requeued: 0 };
        for (;;) {
            const r = await this.runOnce();
            if (r.hours === 0) return total;
            total.hours += r.hours;
            total.days += r.days;
            total.requeued += r.requeued;
        }
    }

    /** Rebuilds the hourly rollups of the given org-hours from raw records, in one aggregation. */
    async recomputeHours(keys: readonly OrgHour[]): Promise<void> {
        if (keys.length === 0) return;
        const groups = await this.db.usageRecords
            .aggregate<HourGroup>([
                { $match: { $or: byOrg(keys).map(([orgId, hours]) => ({ orgId, hour: { $in: hours } })) } },
                {
                    $group: {
                        _id: { orgId: "$orgId", hour: "$hour", serviceId: "$serviceId", meter: "$meter" },
                        quantity: { $sum: "$quantity" },
                        recordCount: { $sum: 1 },
                        lateRecords: {
                            $sum: { $cond: [{ $gt: ["$ingestedAt", { $add: ["$hour", 3_600_000 + HOUR_CLOSE_GRACE_MS] }] }, 1, 0] },
                        },
                    },
                },
            ])
            .toArray();
        if (groups.length === 0) return;
        const now = this.clock.now();
        const ops: AnyBulkWriteOperation<HourlyRollup>[] = groups.map((g) => ({
            updateOne: {
                filter: { _id: rollupId(g._id.orgId, g._id.serviceId, g._id.meter, g._id.hour) },
                update: {
                    $set: {
                        orgId: g._id.orgId,
                        serviceId: g._id.serviceId,
                        meter: g._id.meter,
                        hour: g._id.hour,
                        quantity: BigInt(g.quantity),
                        recordCount: g.recordCount,
                        lateRecords: g.lateRecords,
                        updatedAt: now,
                    },
                },
                upsert: true,
            },
        }));
        await this.db.hourlyRollups.bulkWrite(ops, { ordered: false });
    }

    /** Rebuilds daily rollups from hourly ones; each key's `hour` is the UTC midnight of the day. */
    async recomputeDays(days: readonly OrgHour[]): Promise<void> {
        if (days.length === 0) return;
        const groups = await this.db.hourlyRollups
            .aggregate<DayGroup>([
                { $match: { $or: days.map((d) => ({ orgId: d.orgId, hour: { $gte: d.hour, $lt: new Date(d.hour.getTime() + DAY_MS) } })) } },
                {
                    $group: {
                        _id: { orgId: "$orgId", day: { $dateTrunc: { date: "$hour", unit: "day" } }, serviceId: "$serviceId", meter: "$meter" },
                        quantity: { $sum: "$quantity" },
                        recordCount: { $sum: "$recordCount" },
                    },
                },
            ])
            .toArray();
        if (groups.length === 0) return;
        const now = this.clock.now();
        const ops: AnyBulkWriteOperation<DailyRollup>[] = groups.map((g) => ({
            updateOne: {
                filter: { _id: rollupId(g._id.orgId, g._id.serviceId, g._id.meter, g._id.day) },
                update: {
                    $set: {
                        orgId: g._id.orgId,
                        serviceId: g._id.serviceId,
                        meter: g._id.meter,
                        day: g._id.day,
                        quantity: BigInt(g.quantity),
                        recordCount: g.recordCount,
                        updatedAt: now,
                    },
                },
                upsert: true,
            },
        }));
        await this.db.dailyRollups.bulkWrite(ops, { ordered: false });
    }
}

function byOrg(keys: readonly OrgHour[]): [string, Date[]][] {
    const map = new Map<string, Date[]>();
    for (const k of keys) map.set(k.orgId, [...(map.get(k.orgId) ?? []), k.hour]);
    return [...map];
}
