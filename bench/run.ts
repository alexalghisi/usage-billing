// Measures ingestion throughput (SQS -> handler -> MongoDB), rollup
// aggregation, and a monthly invoice run for many orgs.
//   npm run bench -- --records 200000 --orgs 1000
import { parseArgs } from "node:util";
import { cpus } from "node:os";
import { createServices } from "../src/app/context.ts";
import { addHours, FixedClock, monthPeriod } from "../src/domain/time.ts";
import { connectDatabase } from "../src/infra/mongo.ts";
import { createSqsClient, ensureQueue, queueDepth } from "../src/infra/sqs.ts";
import { runInvoices } from "../src/invoicing/invoice-run.ts";
import { createUsageHandler } from "../src/metering/handler.ts";
import { MongoUsageStore } from "../src/metering/mongo-usage-store.ts";
import { SqsPoller } from "../src/metering/poller.ts";
import { UsagePublisher } from "../src/metering/producer.ts";
import type { UsageRecordInput } from "../src/metering/record.ts";
import { rollupId, type HourlyRollup } from "../src/rollups/types.ts";
import { startLocalEnv } from "../src/cli/local-env.ts";

const { values } = parseArgs({ options: { records: { type: "string", default: "200000" }, orgs: { type: "string", default: "1000" } } });
const RECORDS = Number(values.records);
const ORGS = Number(values.orgs);
const out = (s: string) => process.stdout.write(`${s}\n`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

const env = await startLocalEnv({ sqsPort: Number(process.env.SQS_PORT ?? 9335) });
const db = await connectDatabase(env.mongoUri, `ub_bench_${Date.now()}`);
const sqs = createSqsClient(env.sqsEndpoint);
out(`machine: ${cpus().length} vCPU (${cpus()[0]?.model ?? "?"}), MongoDB ${process.env.MONGO_URL ? "external" : "mongodb-memory-server (single-node replica set, WiredTiger)"}, ElasticMQ`);

try {
    // 1. Ingestion through SQS.
    const clock = new FixedClock(new Date("2026-10-01T00:30:00Z"));
    const month = monthPeriod("2026-09");
    const records: UsageRecordInput[] = Array.from({ length: RECORDS }, (_, i) => ({
        eventId: `e${i}`,
        orgId: `org_${i % 500}`,
        serviceId: `svc_${i % 7}`,
        meter: (["compute", "storage", "transfer"] as const)[i % 3] ?? "compute",
        quantity: `${(i % 997) + 1}.${String(i % 1000).padStart(3, "0")}`,
        timestamp: new Date(month.start.getTime() + (i % 720) * 3_600_000 + (i % 3600) * 1000).toISOString(),
    }));
    const queue = await ensureQueue(sqs, `bench-${Date.now()}`, 5);
    const publisher = new UsagePublisher(sqs, queue.queueUrl, 100);
    let t = performance.now();
    const messages = await publisher.publish(records);
    const publishMs = performance.now() - t;
    out(`\npublish   ${RECORDS.toLocaleString()} records in ${messages.toLocaleString()} messages (100 records each): ${secs(publishMs)}, ${Math.round(RECORDS / (publishMs / 1000)).toLocaleString()} records/s`);

    const handler = createUsageHandler({ store: new MongoUsageStore(db), clock });
    for (const concurrency of [1, 2, 4]) {
        if (concurrency > 1) {
            await db.usageRecords.deleteMany({});
            await db.dirtyHours.deleteMany({});
            await publisher.publish(records);
        }
        const poller = new SqsPoller({ sqs, queueUrl: queue.queueUrl, queueArn: queue.queueArn, handler, batchSize: 20, batchingWindowMs: 50, concurrency });
        t = performance.now();
        poller.start();
        while ((await queueDepth(sqs, queue.queueUrl)) > 0) await new Promise((r) => setTimeout(r, 50));
        await poller.stop();
        const ms = performance.now() - t;
        const stored = await db.usageRecords.countDocuments();
        out(`consume   concurrency ${concurrency}: ${stored.toLocaleString()} records stored in ${secs(ms)}, ${Math.round(stored / (ms / 1000)).toLocaleString()} records/s`);
    }

    const services = createServices(db, clock);
    t = performance.now();
    const agg = await services.aggregator.drain();
    const aggMs = performance.now() - t;
    out(`rollups   ${agg.hours.toLocaleString()} org-hours and ${agg.days.toLocaleString()} org-days rebuilt from raw in ${secs(aggMs)}`);

    // 2. Invoice run for ORGS orgs over a full month of hourly rollups.
    await db.usageRecords.deleteMany({});
    await db.hourlyRollups.deleteMany({});
    const plans = ["developer", "scale", "enterprise"];
    const setupClock = new FixedClock(new Date("2026-08-15T00:00:00Z"));
    const setup = createServices(db, setupClock);
    t = performance.now();
    for (let i = 0; i < ORGS; i++) {
        await setup.orgs.create({
            _id: `org_b${i}`,
            name: `Bench ${i}`,
            billing: { channel: "invoice" },
            taxProfile: [{ country: "IE" }, { country: "DE", vatId: "DE811569869" }, { country: "US", region: "WA" }][i % 3] ?? { country: "IE" },
            planId: plans[i % 3] ?? "scale",
            startsAt: new Date("2026-08-01T00:00:00Z"),
            ...(i % 4 === 0 ? { trialCredit: { amount: 30_000n, days: 90 } } : {}),
        });
    }
    let batch: HourlyRollup[] = [];
    let rollups = 0;
    for (let i = 0; i < ORGS; i++) {
        for (let h = month.start; h < month.end; h = addHours(h, 1)) {
            for (const meter of ["compute", "storage", "transfer"] as const) {
                batch.push({ _id: rollupId(`org_b${i}`, "svc", meter, h), orgId: `org_b${i}`, serviceId: "svc", meter, hour: h, quantity: BigInt(1_000_000 + ((i * 7919 + h.getTime() / 3_600_000) % 400) * 1_000_000), recordCount: 1, lateRecords: 0, updatedAt: setupClock.now() });
            }
        }
        if (batch.length >= 20_000) {
            await db.hourlyRollups.insertMany(batch, { ordered: false });
            rollups += batch.length;
            batch = [];
        }
    }
    if (batch.length) await db.hourlyRollups.insertMany(batch, { ordered: false });
    rollups += batch.length;
    out(`\nsetup     ${ORGS.toLocaleString()} orgs and ${rollups.toLocaleString()} hourly rollups written in ${secs(performance.now() - t)}`);

    const runClock = new FixedClock(new Date("2026-10-01T03:00:00Z"));
    const run = createServices(db, runClock);
    for (const [label, finalize] of [["drafts", false], ["finalize", true]] as const) {
        const r = await runInvoices(run.invoices, run.orgs, "2026-09", { finalize, concurrency: 8 });
        out(
            `invoices  ${label}: ${(r.created + r.updated + r.unchanged).toLocaleString()} drafts, ${r.finalized.toLocaleString()} finalized, ${r.failed.length} failed in ${secs(r.durationMs)} (${Math.round(ORGS / (r.durationMs / 1000))} orgs/s)`,
        );
    }
    const audit = await run.audit.verify();
    out(`audit     ${audit.ok ? audit.entries.toLocaleString() : "BROKEN"} entries verified`);
} finally {
    await db.drop();
    await db.client.close();
    sqs.destroy();
    await env.stop();
}
