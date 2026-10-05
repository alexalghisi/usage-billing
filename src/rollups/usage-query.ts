import { zeroQuantities, type Meter, type MeterQuantities } from "../domain/meters.ts";
import type { Database } from "../infra/mongo.ts";
import type { HourlyRollup } from "./types.ts";

export interface SeriesPoint {
    bucket: Date;
    quantities: MeterQuantities;
}

/** Read side over the rollups, used by rating, invoicing, the API and marketplace reporting. */
export class UsageQuery {
    private readonly db: Database;
    constructor(db: Database) {
        this.db = db;
    }

    /** Usage per meter for hours in [from, to). Both bounds must be hour-aligned. */
    async totals(orgId: string, from: Date, to: Date): Promise<MeterQuantities> {
        const groups = await this.db.hourlyRollups
            .aggregate<{ _id: Meter; quantity: bigint }>([
                { $match: { orgId, hour: { $gte: from, $lt: to } } },
                { $group: { _id: "$meter", quantity: { $sum: "$quantity" } } },
            ])
            .toArray();
        const out = zeroQuantities();
        for (const g of groups) out[g._id] = BigInt(g.quantity);
        return out;
    }

    /** Same as totals() for many orgs in one pass. */
    async totalsForOrgs(orgIds: readonly string[], from: Date, to: Date): Promise<Map<string, MeterQuantities>> {
        const groups = await this.db.hourlyRollups
            .aggregate<{ _id: { orgId: string; meter: Meter }; quantity: bigint }>([
                { $match: { orgId: { $in: [...orgIds] }, hour: { $gte: from, $lt: to } } },
                { $group: { _id: { orgId: "$orgId", meter: "$meter" }, quantity: { $sum: "$quantity" } } },
            ])
            .toArray();
        const out = new Map<string, MeterQuantities>(orgIds.map((id) => [id, zeroQuantities()]));
        for (const g of groups) {
            const q = out.get(g._id.orgId);
            if (q) q[g._id.meter] = BigInt(g.quantity);
        }
        return out;
    }

    async series(orgId: string, from: Date, to: Date, granularity: "hour" | "day"): Promise<SeriesPoint[]> {
        const groups =
            granularity === "hour"
                ? await this.db.hourlyRollups
                      .aggregate<{ _id: { bucket: Date; meter: Meter }; quantity: bigint }>([
                          { $match: { orgId, hour: { $gte: from, $lt: to } } },
                          { $group: { _id: { bucket: "$hour", meter: "$meter" }, quantity: { $sum: "$quantity" } } },
                      ])
                      .toArray()
                : await this.db.dailyRollups
                      .aggregate<{ _id: { bucket: Date; meter: Meter }; quantity: bigint }>([
                          { $match: { orgId, day: { $gte: from, $lt: to } } },
                          { $group: { _id: { bucket: "$day", meter: "$meter" }, quantity: { $sum: "$quantity" } } },
                      ])
                      .toArray();
        const points = new Map<number, SeriesPoint>();
        for (const g of groups) {
            const t = g._id.bucket.getTime();
            const p = points.get(t) ?? { bucket: g._id.bucket, quantities: zeroQuantities() };
            p.quantities[g._id.meter] = BigInt(g.quantity);
            points.set(t, p);
        }
        return [...points.values()].sort((a, b) => a.bucket.getTime() - b.bucket.getTime());
    }

    /** The hourly rollups behind an invoice line, for drill-down. */
    async rollups(orgId: string, meter: Meter, from: Date, to: Date): Promise<HourlyRollup[]> {
        return this.db.hourlyRollups.find({ orgId, meter, hour: { $gte: from, $lt: to } }).sort({ hour: 1, serviceId: 1 }).toArray();
    }
}

