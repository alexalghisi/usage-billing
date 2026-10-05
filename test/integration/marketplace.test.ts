import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServices, type Services } from "../../src/app/context.ts";
import { FixedClock } from "../../src/domain/time.ts";
import type { Database } from "../../src/infra/mongo.ts";
import { seededRandom } from "../../src/infra/random.ts";
import { FakeAwsMetering } from "../../src/marketplace/fake-aws-metering.ts";
import { AwsMeteringClient } from "../../src/marketplace/metering-client.ts";
import { MarketplaceReporter } from "../../src/marketplace/reporter.ts";
import { testDatabase } from "../helpers/env.ts";
import { ingest, usage } from "../helpers/records.ts";

const clock = new FixedClock(new Date("2026-09-01T00:00:00Z"));
let fake: FakeAwsMetering;
let server: FastifyInstance;
let client: AwsMeteringClient;
const open: Database[] = [];

beforeAll(async () => {
    fake = new FakeAwsMetering(clock, seededRandom(7));
    fake.subscribe("prod-qc", "cust-1");
    server = fake.buildServer();
    const address = await server.listen({ port: 0, host: "127.0.0.1" });
    client = new AwsMeteringClient({ endpoint: address, maxAttempts: 2 });
});
afterAll(async () => {
    client.destroy();
    await server.close();
});
afterEach(async () => {
    fake.records.clear();
    fake.requests = 0;
    fake.faults = { errorRate: 0, throttleRate: 0, unprocessedRate: 0, lostResponseRate: 0, latencyMs: 0 };
    for (const db of open.splice(0)) {
        await db.drop();
        await db.client.close();
    }
});

async function setup(customerIdentifier = "cust-1"): Promise<Services & { reporter: MarketplaceReporter }> {
    const db = await testDatabase("mkt");
    open.push(db);
    clock.set(new Date("2026-09-01T00:00:00Z"));
    const s = createServices(db, clock);
    await s.orgs.create({ _id: "org_m", name: "M", billing: { channel: "aws_marketplace", customerIdentifier, productCode: "prod-qc" }, taxProfile: { country: "US" }, planId: "scale" });
    const reporter = new MarketplaceReporter({ db, client, clock, usage: s.usage, audit: s.audit });
    await reporter.ensureIndexes();
    return { ...s, reporter };
}

async function meter(s: Services, quantity: string, at: string, meterName: "compute" | "storage" = "compute") {
    const now = clock.now();
    clock.set(new Date(Math.max(now.getTime(), new Date(at).getTime())));
    await ingest(s.db, [usage("org_m", meterName, quantity, at, clock)]);
    clock.set(now);
    await s.aggregator.drain();
}

const reported = (dimension: string) => fake.totals().get(`cust-1|${dimension}`) ?? 0;

describe("marketplace reporting", () => {
    it("reports whole units per closed hour and carries fractions forward", async () => {
        const s = await setup();
        await meter(s, "10.6", "2026-09-01T00:10:00Z");
        await meter(s, "0.6", "2026-09-01T01:10:00Z");

        clock.set(new Date("2026-09-01T02:59:00Z")); // hour 00 closes at 03:00 (end + 2h grace)
        expect(await s.reporter.runOnce()).toMatchObject({ planned: 0, requests: 0 });
        clock.set(new Date("2026-09-01T03:00:00Z"));
        expect(await s.reporter.runOnce()).toMatchObject({ planned: 1, accepted: 1 });
        expect(reported("compute_unit_minutes")).toBe(10);

        clock.set(new Date("2026-09-01T04:00:00Z"));
        await s.reporter.runOnce();
        expect(reported("compute_unit_minutes")).toBe(11); // 11.2 so far
        expect(fake.records.size).toBe(2);
        expect((await s.audit.list({ orgId: "org_m" })).filter((e) => e.action === "marketplace.usage_reported")).toHaveLength(2);
    });

    it("never reports the same hour twice and sends late usage with the next hour", async () => {
        const s = await setup();
        await meter(s, "5", "2026-09-01T00:10:00Z");
        clock.set(new Date("2026-09-01T03:00:00Z"));
        await s.reporter.runOnce();
        await s.reporter.runOnce();
        expect(fake.requests).toBe(1);

        await meter(s, "7", "2026-09-01T00:20:00Z"); // late, for an hour already reported
        await s.reporter.runOnce();
        expect(reported("compute_unit_minutes")).toBe(5);
        clock.set(new Date("2026-09-01T04:00:00Z"));
        await s.reporter.runOnce();
        expect(reported("compute_unit_minutes")).toBe(12);
    });

    it("ends up exact under throttling, errors, unprocessed records and lost responses", async () => {
        const s = await setup();
        fake.faults = { errorRate: 0.25, throttleRate: 0.15, unprocessedRate: 0.2, lostResponseRate: 0.2, latencyMs: 0 };
        const random = seededRandom(42);
        let expectedCompute = 0n;
        let expectedStorage = 0n;
        for (let h = 0; h < 24; h++) {
            const c = BigInt(Math.floor(random() * 5_000_000_000)); // micro-units
            const st = BigInt(Math.floor(random() * 900_000_000));
            expectedCompute += c;
            expectedStorage += st;
            const at = new Date(Date.UTC(2026, 8, 1, h, 30)).toISOString();
            await meter(s, (Number(c) / 1e6).toFixed(6), at);
            await meter(s, (Number(st) / 1e6).toFixed(6), at, "storage");
        }
        for (let minute = 0; minute <= 30 * 60; minute += 10) {
            clock.set(new Date(Date.UTC(2026, 8, 1, 0, minute)));
            await s.reporter.runOnce();
        }
        fake.faults = { errorRate: 0, throttleRate: 0, unprocessedRate: 0, lostResponseRate: 0, latencyMs: 0 };
        clock.set(new Date(Date.UTC(2026, 8, 2, 7, 0)));
        await s.reporter.runOnce();
        expect(BigInt(reported("compute_unit_minutes"))).toBe(expectedCompute / 1_000_000n);
        expect(BigInt(reported("storage_gb_hours"))).toBe(expectedStorage / 1_000_000n);
        const duplicates = await s.db.db.collection("marketplace_reports").countDocuments({ duplicate: true });
        expect(duplicates).toBeGreaterThan(0); // lost responses were retried and deduplicated by AWS
    });

    it("re-plans units whose report got too old to send", async () => {
        const s = await setup();
        await meter(s, "9", "2026-09-01T00:10:00Z");
        fake.faults = { errorRate: 1, throttleRate: 0, unprocessedRate: 0, lostResponseRate: 0, latencyMs: 0 };
        clock.set(new Date("2026-09-01T03:00:00Z"));
        await s.reporter.runOnce();
        fake.faults = { errorRate: 0, throttleRate: 0, unprocessedRate: 0, lostResponseRate: 0, latencyMs: 0 };
        clock.set(new Date("2026-09-01T07:00:00Z"));
        const stats = await s.reporter.runOnce();
        expect(stats).toMatchObject({ expired: 1, planned: 1, accepted: 1 });
        expect(reported("compute_unit_minutes")).toBe(9);
        expect([...fake.records.values()][0]?.timestamp.toISOString()).toBe("2026-09-01T04:00:00.000Z");
    });

    it("marks reports for an unsubscribed customer as rejected", async () => {
        const s = await setup("cust-unknown");
        await meter(s, "3", "2026-09-01T00:10:00Z");
        clock.set(new Date("2026-09-01T03:00:00Z"));
        expect(await s.reporter.runOnce()).toMatchObject({ rejected: 1, accepted: 0 });
        expect((await s.reporter.list("org_m"))[0]?.status).toBe("rejected");
    });
});
