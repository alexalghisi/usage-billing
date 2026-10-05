import type { SQSClient } from "@aws-sdk/client-sqs";
import { createServices } from "../app/context.ts";
import { METERS } from "../domain/meters.ts";
import { addHours, FixedClock, monthPeriod } from "../domain/time.ts";
import type { InvoiceRunResult } from "../invoicing/invoice-run.ts";
import { runInvoices } from "../invoicing/invoice-run.ts";
import type { Database } from "../infra/mongo.ts";
import { seededRandom } from "../infra/random.ts";
import { queueDepth } from "../infra/sqs.ts";
import { FakeAwsMetering } from "../marketplace/fake-aws-metering.ts";
import { AwsMeteringClient } from "../marketplace/metering-client.ts";
import { DIMENSIONS, MarketplaceReporter, type ReporterStats } from "../marketplace/reporter.ts";
import { createUsageHandler, type IngestStats } from "../metering/handler.ts";
import { MongoUsageStore } from "../metering/mongo-usage-store.ts";
import { SqsPoller } from "../metering/poller.ts";
import { UsagePublisher } from "../metering/producer.ts";
import { reconcile } from "../rollups/reconcile.ts";
import { expectedOutcome, type ExpectedInvoice } from "./oracle.ts";
import { buildWorkload, type Phase, type SimEvent } from "./workload.ts";

export interface SimulationOptions {
    orgs: number;
    seed: number;
    /** Records per SQS message. */
    recordsPerMessage?: number;
    onProgress?: (message: string) => void;
}

export interface SimulationEnv {
    db: Database;
    sqs: SQSClient;
    queueUrl: string;
    queueArn: string;
    dlqUrl: string;
}

export interface InvoiceComparison {
    orgId: string;
    period: string;
    expected: ExpectedInvoice;
    actual: ExpectedInvoice;
    match: boolean;
}

export interface SimulationReport {
    orgs: number;
    records: number;
    resent: number;
    malformedMessages: number;
    messages: number;
    ingest: IngestStats & { seconds: number; recordsPerSecond: number };
    deadLettered: number;
    invoiceRuns: InvoiceRunResult[];
    comparisons: InvoiceComparison[];
    mismatches: InvoiceComparison[];
    adjustmentLines: number;
    marketplace: {
        dimensions: number;
        expectedUnits: bigint;
        reportedUnits: bigint;
        /** Units in reports left unresolved that AWS in fact never received. */
        unresolvedMissingUnits: bigint;
        unresolvedReports: number;
        mismatched: string[];
        stats: ReporterStats;
    };
    reconcileMismatches: number;
    auditEntries: number;
    auditOk: boolean;
    invoicesVerified: boolean;
}

const MALFORMED = ['{"records":"nope"}', "not json at all", '{"records":[{"orgId":"org_0001","meter":"cpu","quantity":"1"}]}'];

export async function runMonthSimulation(options: SimulationOptions, env: SimulationEnv): Promise<SimulationReport> {
    const log = options.onProgress ?? (() => {});
    const workload = buildWorkload({ orgs: options.orgs, seed: options.seed });
    const month = monthPeriod(workload.month);
    const next = monthPeriod(workload.nextMonth);
    const clock = new FixedClock(month.start);
    const services = createServices(env.db, clock);
    const { db, orgs, invoices, aggregator } = services;

    // Fake AWS Marketplace, with faults switched on while usage is reported.
    const fake = new FakeAwsMetering(clock, seededRandom(options.seed + 1));
    const server = fake.buildServer();
    const endpoint = await server.listen({ port: 0, host: "127.0.0.1" });
    const client = new AwsMeteringClient({ endpoint });
    const reporter = new MarketplaceReporter({ db, client, clock, usage: services.usage, audit: services.audit, retryDelayMs: 1 });
    await reporter.ensureIndexes();

    const ingest: IngestStats = { messages: 0, inserted: 0, duplicates: 0, rejected: 0, failedMessages: 0 };
    const handler = createUsageHandler({
        store: new MongoUsageStore(db),
        clock,
        onStats: (s) => {
            ingest.messages += s.messages;
            ingest.inserted += s.inserted;
            ingest.duplicates += s.duplicates;
            ingest.rejected += s.rejected;
            ingest.failedMessages += s.failedMessages;
        },
    });
    const poller = new SqsPoller({ sqs: env.sqs, queueUrl: env.queueUrl, queueArn: env.queueArn, handler, batchSize: 40, concurrency: 2, retryDelaySeconds: 1 });
    const publisher = new UsagePublisher(env.sqs, env.queueUrl, options.recordsPerMessage ?? 50);
    let messages = 0;
    let ingestMs = 0;

    try {
        log(`creating ${workload.orgs.length} orgs`);
        for (const o of workload.orgs) {
            await orgs.create({
                _id: o.id,
                name: o.name,
                billing: o.marketplace ? { channel: "aws_marketplace", ...o.marketplace } : { channel: "invoice" },
                taxProfile: o.taxProfile,
                planId: o.planId,
                startsAt: o.startsAt,
                ...(o.trial ? { trialCredit: o.trial } : {}),
            });
            if (o.upgrade) await orgs.changePlan(o.id, o.upgrade.planId, "sim", o.upgrade.at);
            if (o.contract) await orgs.signContract(o.id, o.contract, "sim");
            if (o.marketplace) fake.subscribe(o.marketplace.productCode, o.marketplace.customerIdentifier);
        }

        const deliver = async (phases: Phase[], at: Date, extra: string[] = []) => {
            clock.set(at);
            const batch: SimEvent[] = workload.events.filter((e) => phases.includes(e.phase));
            const started = performance.now();
            messages += await publisher.publish(batch.map((e) => e.record));
            // Producers that time out resend: the copies arrive in later messages.
            messages += await publisher.publish(batch.filter((e) => e.duplicate).map((e) => e.record));
            if (extra.length) {
                await publisher.sendBodies(extra);
                messages += extra.length;
            }
            poller.start();
            while ((await queueDepth(env.sqs, env.queueUrl)) > 0) await new Promise((r) => setTimeout(r, 100));
            await poller.stop();
            ingestMs += performance.now() - started;
            await aggregator.drain();
            log(`delivered ${batch.length} records (${phases.join(", ")}) at ${at.toISOString()}`);
        };

        const reporterStats: ReporterStats = { planned: 0, requests: 0, failedRequests: 0, accepted: 0, duplicates: 0, rejected: 0, unprocessed: 0, expired: 0, unresolved: 0 };
        const report = async (from: Date, to: Date, stepHours: number) => {
            const started = performance.now();
            fake.faults = { errorRate: 0.1, throttleRate: 0.1, unprocessedRate: 0.1, lostResponseRate: 0.1, latencyMs: 0 };
            for (let t = from; t <= to; t = addHours(t, stepHours)) {
                clock.set(t);
                const s = await reporter.runOnce();
                for (const k of Object.keys(s) as (keyof ReporterStats)[]) reporterStats[k] += s[k];
            }
            log(`marketplace reporting ${from.toISOString().slice(0, 13)}h to ${to.toISOString().slice(0, 13)}h, hourly (${((performance.now() - started) / 1000).toFixed(1)} s)`);
            fake.faults = { errorRate: 0, throttleRate: 0, unprocessedRate: 0, lostResponseRate: 0, latencyMs: 0 };
        };

        await deliver(["on_time"], new Date(month.end.getTime() + 10 * 60_000), MALFORMED);
        await report(addHours(month.start, 3), month.end, 1);
        await deliver(["late"], addHours(month.end, 2));

        clock.set(addHours(month.end, 3));
        log(`invoice run ${workload.month}`);
        const first = await runInvoices(invoices, orgs, workload.month, { finalize: true, concurrency: 4 });

        const endOfNext = new Date(next.start.getTime() + workload.nextMonthDays * 86_400_000);
        await deliver(["after_final", "next_month"], new Date(endOfNext.getTime() + 10 * 60_000));
        await report(addHours(month.end, 3), addHours(endOfNext, 3), 1);
        clock.set(addHours(endOfNext, 4));
        const flush = await reporter.runOnce(); // no faults: flush everything still pending
        for (const k of Object.keys(flush) as (keyof ReporterStats)[]) reporterStats[k] += flush[k];

        clock.set(addHours(next.end, 3));
        log(`invoice run ${workload.nextMonth}`);
        const second = await runInvoices(invoices, orgs, workload.nextMonth, { finalize: true, concurrency: 4 });

        // Compare with the independent calculation.
        const expected = expectedOutcome(workload, services.catalog);
        const comparisons: InvoiceComparison[] = [];
        let adjustmentLines = 0;
        let verified = true;
        for (const [orgId, exp] of expected.invoices) {
            for (const [period, e] of [
                [workload.month, exp.month],
                [workload.nextMonth, exp.next],
            ] as const) {
                const inv = await db.invoices.findOne({ activeKey: `${orgId}|${period}` });
                const actual: ExpectedInvoice = inv
                    ? { subtotal: inv.subtotal, discount: inv.discount, credits: inv.credits, tax: inv.tax.amount, total: inv.total }
                    : { subtotal: -1n, discount: -1n, credits: -1n, tax: -1n, total: -1n };
                if (inv) {
                    adjustmentLines += inv.lines.filter((l) => l.kind === "adjustment").length;
                    verified &&= inv.status === "finalized" && invoices.verify(inv);
                }
                const match = (Object.keys(e) as (keyof ExpectedInvoice)[]).every((k) => e[k] === actual[k]);
                comparisons.push({ orgId, period, expected: e, actual, match });
            }
        }

        // An unresolved report that AWS never got leaves a known gap (under-billing, flagged for reconciliation).
        const missing = new Map<string, bigint>();
        const unresolved = await reporter.unresolved();
        for (const r of unresolved) {
            const recorded = [...fake.records.values()].some((m) => m.customerIdentifier === r.customerIdentifier && m.dimension === r.dimension && m.timestamp.getTime() === r.hour.getTime());
            if (!recorded) missing.set(`${r.customerIdentifier}|${r.meter}`, (missing.get(`${r.customerIdentifier}|${r.meter}`) ?? 0n) + BigInt(r.quantity));
        }
        const mismatched: string[] = [];
        const totals = fake.totals();
        let expectedUnits = 0n;
        let reportedUnits = 0n;
        for (const [key, units] of expected.marketplaceUnits) {
            const [customer, meter] = key.split("|") as [string, (typeof METERS)[number]];
            const got = BigInt(totals.get(`${customer}|${DIMENSIONS[meter]}`) ?? 0);
            expectedUnits += units;
            reportedUnits += got;
            if (got + (missing.get(key) ?? 0n) !== units) mismatched.push(`${key}: expected ${units}, reported ${got}`);
        }

        const rec = await reconcile(db, { from: month.start, to: next.end });
        const audit = await services.audit.verify();
        return {
            orgs: workload.orgs.length,
            records: workload.events.length,
            resent: workload.events.filter((e) => e.duplicate).length,
            malformedMessages: MALFORMED.length,
            messages,
            ingest: { ...ingest, seconds: ingestMs / 1000, recordsPerSecond: Math.round((ingest.inserted + ingest.duplicates) / (ingestMs / 1000)) },
            deadLettered: await queueDepth(env.sqs, env.dlqUrl),
            invoiceRuns: [first, second],
            comparisons,
            mismatches: comparisons.filter((c) => !c.match),
            adjustmentLines,
            marketplace: {
                dimensions: expected.marketplaceUnits.size,
                expectedUnits,
                reportedUnits,
                unresolvedMissingUnits: [...missing.values()].reduce((a, b) => a + b, 0n),
                unresolvedReports: unresolved.length,
                mismatched,
                stats: reporterStats,
            },
            reconcileMismatches: rec.mismatches.length,
            auditEntries: audit.ok ? audit.entries : 0,
            auditOk: audit.ok,
            invoicesVerified: verified,
        };
    } finally {
        await poller.stop();
        client.destroy();
        await server.close();
    }
}
