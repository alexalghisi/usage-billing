// Local demo: seeds two and a half months of billing history, then keeps
// usage flowing through SQS in accelerated time while the API serves the UI.
//   npm run dev            (API on :4310; run `npm run dev -w web` for the UI on :5310)
//   DEMO_SPEED=3600        simulated seconds per real second (default 1800)
import { buildApi } from "../api/server.ts";
import { createServices } from "../app/context.ts";
import { DEMO_ORGS, emitUsage, type DemoOrg } from "../demo/fleet.ts";
import { AcceleratedClock, addHours, FixedClock, HOUR_MS, startOfHour } from "../domain/time.ts";
import { jsonLogger } from "../infra/logger.ts";
import { connectDatabase } from "../infra/mongo.ts";
import { createSqsClient, ensureQueue } from "../infra/sqs.ts";
import { runInvoices } from "../invoicing/invoice-run.ts";
import { FakeAwsMetering } from "../marketplace/fake-aws-metering.ts";
import { AwsMeteringClient } from "../marketplace/metering-client.ts";
import { MarketplaceReporter } from "../marketplace/reporter.ts";
import { createUsageHandler } from "../metering/handler.ts";
import { MongoUsageStore } from "../metering/mongo-usage-store.ts";
import { SqsPoller } from "../metering/poller.ts";
import { UsagePublisher } from "../metering/producer.ts";
import { validateRecord } from "../metering/record.ts";
import { startLocalEnv } from "./local-env.ts";

const API_PORT = Number(process.env.API_PORT ?? 4310);
const AWS_PORT = Number(process.env.FAKE_AWS_PORT ?? 4311);
const SPEED = Number(process.env.DEMO_SPEED ?? 1800);
const HISTORY_FROM = new Date("2026-07-01T00:00:00Z");
const NOW = new Date(process.env.DEMO_START ?? "2026-09-24T09:00:00Z");
const log = (msg: string) => process.stdout.write(`${msg}\n`);

const env = await startLocalEnv({ sqsPort: Number(process.env.SQS_PORT ?? 9335) });
const db = await connectDatabase(env.mongoUri, "ub_demo");
await db.drop();
await db.ensureIndexes();

/** Writes usage straight to MongoDB, each hour as if it had arrived a few minutes after it ended. */
async function insertDirect(org: DemoOrg, from: Date, to: Date): Promise<void> {
    const store = new MongoUsageStore(db);
    const arrival = new FixedClock(from);
    const records = [];
    for (let t = from; t < to; t = addHours(t, 1)) {
        arrival.set(new Date(t.getTime() + HOUR_MS + 5 * 60_000));
        for (const input of emitUsage(org, t, addHours(t, 1))) {
            const v = validateRecord(input, arrival);
            if (v.ok) records.push(v.record);
        }
    }
    for (let i = 0; i < records.length; i += 5000) {
        const chunk = records.slice(i, i + 5000);
        await store.insert(chunk);
        await store.markDirty(chunk.map((r) => ({ orgId: r.orgId, hour: r.hour })));
    }
}

async function seedHistory(fake: FakeAwsMetering): Promise<void> {
    const clock = new FixedClock(HISTORY_FROM);
    const s = createServices(db, clock);
    for (const o of DEMO_ORGS) {
        const startsAt = new Date(o.startsAt ?? HISTORY_FROM);
        await s.orgs.create({
            _id: o.id,
            name: o.name,
            billing: o.billing,
            taxProfile: o.taxProfile,
            planId: o.planId,
            startsAt,
            ...(o.trialFrom ? { trialCredit: { amount: 30_000n, days: 30 } } : {}),
        });
        if (o.upgrade) await s.orgs.changePlan(o.id, o.upgrade.planId, "sales", new Date(o.upgrade.at));
        if (o.contract) await s.orgs.signContract(o.id, { ...o.contract, startsAt: HISTORY_FROM, endsAt: new Date("2027-07-01T00:00:00Z") }, "sales");
        if (o.billing.channel === "aws_marketplace") fake.subscribe(o.billing.productCode, o.billing.customerIdentifier);
    }

    // Usage up to "now", as if it had arrived on time.
    clock.set(NOW);
    for (const o of DEMO_ORGS) await insertDirect(o, new Date(o.startsAt ?? HISTORY_FROM), startOfHour(NOW));
    await s.aggregator.drain();

    for (const [period, closeAt] of [
        ["2026-07", "2026-08-01T03:00:00Z"],
        ["2026-08", "2026-09-01T03:00:00Z"],
    ] as const) {
        clock.set(new Date(closeAt));
        await runInvoices(s.invoices, s.orgs, period, { finalize: true });
        for (const inv of await db.invoices.find({ period, status: "finalized" }).toArray()) {
            if (period === "2026-07" || inv.orgId !== "org_acme") await s.invoices.markPaid(inv._id, "stripe-webhook", `pi_${inv._id.slice(-12)}`);
        }
    }

    // A replica's metering agent was down for a day; its August backlog arrives after August was invoiced.
    clock.set(new Date("2026-09-03T10:00:00Z"));
    const store = new MongoUsageStore(db);
    for (const orgId of ["org_acme", "org_globex"]) {
        const late = [];
        for (let t = new Date("2026-08-30T00:00:00Z"); t < new Date("2026-08-31T00:00:00Z"); t = addHours(t, 1)) {
            const v = validateRecord(
                { eventId: `backlog/${t.toISOString()}`, orgId, serviceId: `${orgId.replace("org_", "")}-analytics`, meter: "compute", quantity: orgId === "org_acme" ? "185.5" : "1650.25", timestamp: t.toISOString() },
                clock,
            );
            if (v.ok) late.push(v.record);
        }
        await store.insert(late);
        await store.markDirty(late.map((r) => ({ orgId: r.orgId, hour: r.hour })));
    }
    await s.aggregator.drain();
    clock.set(NOW);
    await runInvoices(s.invoices, s.orgs, "2026-09", { finalize: false });
}

const fake = new FakeAwsMetering({ now: () => clock.now() });
log("seeding history (July to now)...");
await seedHistory(fake);
const clock = new AcceleratedClock(NOW, SPEED);

const services = createServices(db, clock);
const sqs = createSqsClient(env.sqsEndpoint);
const queue = await ensureQueue(sqs, "usage-records", 5);
const handler = createUsageHandler({ store: new MongoUsageStore(db), clock });
const poller = new SqsPoller({ sqs, queueUrl: queue.queueUrl, queueArn: queue.queueArn, handler, batchSize: 50, batchingWindowMs: 100, logger: jsonLogger });
poller.start();
const publisher = new UsagePublisher(sqs, queue.queueUrl);

const fakeServer = fake.buildServer();
const awsEndpoint = await fakeServer.listen({ port: AWS_PORT, host: "127.0.0.1" });
fake.faults = { errorRate: 0.05, throttleRate: 0.05, unprocessedRate: 0.05, lostResponseRate: 0.05, latencyMs: 20 };
const meteringClient = new AwsMeteringClient({ endpoint: awsEndpoint });
const reporter = new MarketplaceReporter({ db, client: meteringClient, clock, usage: services.usage, audit: services.audit });
await reporter.ensureIndexes();

const api = buildApi(services, { reporter });
await api.listen({ port: API_PORT, host: "127.0.0.1" });
log(`API on http://127.0.0.1:${API_PORT}, fake AWS Marketplace on ${awsEndpoint}, ${SPEED}x time from ${NOW.toISOString()}`);

// Services emit what they used since the last tick.
let emittedUntil = clock.now();
const timers = [
    setInterval(() => {
        const until = clock.now();
        const records = [];
        // Split at hour boundaries so every hour gets exactly the usage that happened in it.
        for (let from = emittedUntil; from < until; ) {
            const to = new Date(Math.min(until.getTime(), startOfHour(from).getTime() + HOUR_MS));
            for (const o of DEMO_ORGS) if (new Date(o.startsAt ?? HISTORY_FROM) <= from) records.push(...emitUsage(o, from, to));
            from = to;
        }
        emittedUntil = until;
        void publisher.publish(records).catch((e: unknown) => log(`publish failed: ${String(e)}`));
    }, 1000),
    setInterval(() => void services.aggregator.runOnce().catch((e: unknown) => log(`aggregation failed: ${String(e)}`)), 1000),
    // Drafts are refreshed continuously so the invoice list matches the running estimate.
    setInterval(() => {
        if (clock.now() < new Date("2026-10-01T00:00:00Z")) void runInvoices(services.invoices, services.orgs, "2026-09", { finalize: false }).catch(() => {});
    }, 5000),
    setInterval(() => void reporter.runOnce().catch((e: unknown) => log(`marketplace reporting failed: ${String(e)}`)), 3000),
];

let closedSeptember = false;
const monthClose = setInterval(() => {
    if (closedSeptember || clock.now() < new Date("2026-10-01T03:00:00Z")) return;
    closedSeptember = true;
    void runInvoices(services.invoices, services.orgs, "2026-09", { finalize: true, logger: jsonLogger });
}, 2000);

async function shutdown(): Promise<void> {
    for (const t of [...timers, monthClose]) clearInterval(t);
    await poller.stop();
    await api.close();
    await fakeServer.close();
    meteringClient.destroy();
    sqs.destroy();
    await db.client.close();
    await env.stop();
    process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
