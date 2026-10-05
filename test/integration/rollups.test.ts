import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/time.ts";
import type { Database } from "../../src/infra/mongo.ts";
import { MongoUsageStore } from "../../src/metering/mongo-usage-store.ts";
import { Aggregator } from "../../src/rollups/aggregator.ts";
import { backfill } from "../../src/rollups/backfill.ts";
import { reconcile } from "../../src/rollups/reconcile.ts";
import { UsageQuery } from "../../src/rollups/usage-query.ts";
import { testDatabase } from "../helpers/env.ts";
import { ingest, usage } from "../helpers/records.ts";

const range = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") };

describe("rollups", () => {
    let db: Database;
    let clock: FixedClock;
    beforeAll(async () => (db = await testDatabase("rollups")));
    beforeEach(async () => {
        await Promise.all([db.usageRecords.deleteMany({}), db.dirtyHours.deleteMany({}), db.hourlyRollups.deleteMany({}), db.dailyRollups.deleteMany({})]);
        clock = new FixedClock(new Date("2026-09-12T12:00:00Z"));
    });
    afterAll(async () => {
        await db.drop();
        await db.client.close();
    });

    it("builds hourly and daily rollups per org, service and meter", async () => {
        clock.set(new Date("2026-09-10T10:00:00Z"));
        await ingest(db, [
            usage("org_a", "compute", "10", "2026-09-10T08:05:00Z", clock),
            usage("org_a", "compute", "2.5", "2026-09-10T08:55:00Z", clock),
            usage("org_a", "compute", "1", "2026-09-10T09:00:00Z", clock),
            usage("org_a", "compute", "4", "2026-09-10T09:10:00Z", clock, "svc_2"),
            usage("org_a", "storage", "100", "2026-09-10T08:00:00Z", clock),
            usage("org_b", "compute", "7", "2026-09-10T08:30:00Z", clock),
        ]);
        const agg = new Aggregator(db, clock);
        expect(await agg.drain()).toEqual({ hours: 3, days: 2, requeued: 0 });

        const hour8 = await db.hourlyRollups.findOne({ orgId: "org_a", serviceId: "svc_1", meter: "compute", hour: new Date("2026-09-10T08:00:00Z") });
        expect(hour8).toMatchObject({ quantity: 12_500_000n, recordCount: 2, lateRecords: 0 });
        const day = await db.dailyRollups.find({ orgId: "org_a", meter: "compute" }).toArray();
        expect(day.map((d) => [d.serviceId, d.quantity])).toEqual(expect.arrayContaining([["svc_1", 13_500_000n], ["svc_2", 4_000_000n]]));

        const q = new UsageQuery(db);
        expect(await q.totals("org_a", range.from, range.to)).toEqual({ compute: 17_500_000n, storage: 100_000_000n, transfer: 0n });
        expect(await db.dirtyHours.countDocuments()).toBe(0);
    });

    it("re-aggregates a closed hour when late data arrives, and counts it as late", async () => {
        clock.set(new Date("2026-09-10T09:00:00Z"));
        const agg = new Aggregator(db, clock);
        await ingest(db, [usage("org_a", "compute", "10", "2026-09-10T08:05:00Z", clock)]);
        await agg.drain();
        clock.set(new Date("2026-09-13T00:00:00Z"));
        await ingest(db, [usage("org_a", "compute", "5", "2026-09-10T08:40:00Z", clock)]);
        await agg.drain();
        const r = await db.hourlyRollups.findOne({ orgId: "org_a", hour: new Date("2026-09-10T08:00:00Z") });
        expect(r).toMatchObject({ quantity: 15_000_000n, recordCount: 2, lateRecords: 1 });
    });

    it("is idempotent", async () => {
        const agg = new Aggregator(db, clock);
        const records = [usage("org_a", "transfer", "3", "2026-09-10T08:05:00Z", clock)];
        await ingest(db, records);
        await agg.drain();
        await ingest(db, records); // redelivery: marks the hour again, inserts nothing
        await agg.drain();
        await agg.recomputeHours("org_a", [new Date("2026-09-10T08:00:00Z")]);
        expect(await db.hourlyRollups.countDocuments()).toBe(1);
        expect((await db.hourlyRollups.findOne({}))?.quantity).toBe(3_000_000n);
    });

    it("keeps a marker that was re-flagged while its hour was being recomputed", async () => {
        class RacingAggregator extends Aggregator {
            override async recomputeHours(orgId: string, hours: readonly Date[]): Promise<void> {
                await super.recomputeHours(orgId, hours);
                await new MongoUsageStore(db).markDirty(hours.map((hour) => ({ orgId, hour })));
            }
        }
        await ingest(db, [usage("org_a", "compute", "1", "2026-09-10T08:05:00Z", clock)]);
        const result = await new RacingAggregator(db, clock).runOnce();
        expect(result.requeued).toBe(1);
        expect(await db.dirtyHours.countDocuments()).toBe(1);
    });

    it("reconciliation finds rollups that disagree with raw records and repairs them", async () => {
        const agg = new Aggregator(db, clock);
        await ingest(db, [usage("org_a", "compute", "10", "2026-09-10T08:05:00Z", clock), usage("org_a", "compute", "1", "2026-09-11T08:05:00Z", clock)]);
        await agg.drain();
        expect((await reconcile(db, range)).mismatches).toEqual([]);

        await db.hourlyRollups.updateOne({ hour: new Date("2026-09-10T08:00:00Z") }, { $set: { quantity: 9_000_000n } });
        await db.dailyRollups.updateOne({ day: new Date("2026-09-11T00:00:00Z") }, { $set: { quantity: 0n } });
        const report = await reconcile(db, { ...range, repair: true });
        expect(report.mismatches.map((m) => [m.level, m.expected, m.actual])).toEqual(
            expect.arrayContaining([
                ["hourly", 10_000_000n, 9_000_000n],
                ["daily", 1_000_000n, 0n],
            ]),
        );
        expect(report.rawRecords).toBe(2);
        await agg.drain();
        expect((await reconcile(db, range)).mismatches).toEqual([]);
    });

    it("backfills records that were imported without dirty markers", async () => {
        await ingest(db, [usage("org_c", "storage", "50", "2026-09-03T01:00:00Z", clock), usage("org_c", "storage", "50", "2026-09-04T01:00:00Z", clock)], false);
        expect((await reconcile(db, range)).mismatches).toHaveLength(4);
        expect(await backfill(db, { ...range, orgId: "org_c" })).toBe(2);
        await new Aggregator(db, clock).drain();
        expect((await reconcile(db, range)).mismatches).toEqual([]);
    });

    it("returns hourly and daily series", async () => {
        await ingest(db, [usage("org_a", "compute", "1", "2026-09-10T08:05:00Z", clock), usage("org_a", "storage", "2", "2026-09-10T09:05:00Z", clock)]);
        await new Aggregator(db, clock).drain();
        const q = new UsageQuery(db);
        const hourly = await q.series("org_a", range.from, range.to, "hour");
        expect(hourly.map((p) => [p.bucket.toISOString(), p.quantities.compute, p.quantities.storage])).toEqual([
            ["2026-09-10T08:00:00.000Z", 1_000_000n, 0n],
            ["2026-09-10T09:00:00.000Z", 0n, 2_000_000n],
        ]);
        expect(await q.series("org_a", range.from, range.to, "day")).toHaveLength(1);
    });
});
