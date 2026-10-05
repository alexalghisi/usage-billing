import type { AnyBulkWriteOperation } from "mongodb";
import type { Meter } from "../domain/meters.ts";
import { DAY_MS, startOfDay, type Clock } from "../domain/time.ts";
import { silentLogger, type Logger } from "../infra/logger.ts";
import type { Database, DirtyHour } from "../infra/mongo.ts";
import { HOUR_CLOSE_GRACE_MS, rollupId, type DailyRollup, type HourlyRollup } from "./types.ts";

export interface AggregationResult {
    hours: number;
    days: number;
    /** Markers left in place because new records arrived while recomputing. */
    requeued: number;
}

interface HourGroup {
    _id: { hour: Date; serviceId: string; meter: Meter };
    quantity: bigint;
    recordCount: number;
    lateRecords: number;
}

interface DayGroup {
    _id: { day: Date; serviceId: string; meter: Meter };
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

    async runOnce(limit = 1000): Promise<AggregationResult> {
        const markers = await this.db.dirtyHours.find({}).sort({ markedAt: 1 }).limit(limit).toArray();
        if (markers.length === 0) return { hours: 0, days: 0, requeued: 0 };
        const byOrg = new Map<string, DirtyHour[]>();
        for (const m of markers) byOrg.set(m.orgId, [...(byOrg.get(m.orgId) ?? []), m]);

        let days = 0;
        for (const [orgId, orgMarkers] of byOrg) {
            const hours = orgMarkers.map((m) => m.hour);
            await this.recomputeHours(orgId, hours);
            const affectedDays = [...new Map(hours.map((h) => [startOfDay(h).getTime(), startOfDay(h)])).values()];
            await this.recomputeDays(orgId, affectedDays);
            days += affectedDays.length;
        }

        // Compare-and-delete: a marker re-flagged during the recompute keeps its new token and survives.
        const res = await this.db.dirtyHours.bulkWrite(
            markers.map((m) => ({ deleteOne: { filter: { _id: m._id, token: m.token } } })),
            { ordered: false },
        );
        const requeued = markers.length - res.deletedCount;
        this.logger.info("rollups recomputed", { hours: markers.length, days, requeued });
        return { hours: markers.length, days, requeued };
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

    async recomputeHours(orgId: string, hours: readonly Date[]): Promise<void> {
        const groups = await this.db.usageRecords
            .aggregate<HourGroup>([
                { $match: { orgId, hour: { $in: [...hours] } } },
                {
                    $group: {
                        _id: { hour: "$hour", serviceId: "$serviceId", meter: "$meter" },
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
                filter: { _id: rollupId(orgId, g._id.serviceId, g._id.meter, g._id.hour) },
                update: {
                    $set: {
                        orgId,
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

    async recomputeDays(orgId: string, days: readonly Date[]): Promise<void> {
        if (days.length === 0) return;
        const groups = await this.db.hourlyRollups
            .aggregate<DayGroup>([
                { $match: { orgId, $or: days.map((d) => ({ hour: { $gte: d, $lt: new Date(d.getTime() + DAY_MS) } })) } },
                {
                    $group: {
                        _id: { day: { $dateTrunc: { date: "$hour", unit: "day" } }, serviceId: "$serviceId", meter: "$meter" },
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
                filter: { _id: rollupId(orgId, g._id.serviceId, g._id.meter, g._id.day) },
                update: {
                    $set: {
                        orgId,
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
