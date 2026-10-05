import type { AuditInput, AuditLog } from "../audit/audit-log.ts";
import { METERS, type Meter } from "../domain/meters.ts";
import { HOUR_MS, startOfHour, type Clock } from "../domain/time.ts";
import { silentLogger, type Logger } from "../infra/logger.ts";
import type { Database } from "../infra/mongo.ts";
import { inTransaction } from "../infra/tx.ts";
import { QTY_SCALE } from "../money/fixed.ts";
import type { Org } from "../orgs/org.ts";
import { HOUR_CLOSE_GRACE_MS } from "../rollups/types.ts";
import type { UsageQuery } from "../rollups/usage-query.ts";
import type { MeteringClient, MeterRecord } from "./metering-client.ts";

export const DIMENSIONS: Record<Meter, string> = {
    compute: "compute_unit_minutes",
    storage: "storage_gb_hours",
    transfer: "data_transfer_gb",
};

/**
 * expired: never reached AWS (only throttled or returned unprocessed) before the
 *   six-hour window closed; the units are planned again under a later hour.
 * unresolved: an attempt may have reached AWS (5xx or lost connection) and the
 *   window closed before a retry settled it. Counted as reported so a customer
 *   is never billed twice, and left for manual reconciliation against AWS reports.
 */
export type ReportStatus = "pending" | "accepted" | "rejected" | "expired" | "unresolved";

export interface MarketplaceReport {
    /** "<orgId>|<dimension>|<hour>": at most one report per org, dimension and hour, like AWS itself. */
    _id: string;
    orgId: string;
    productCode: string;
    customerIdentifier: string;
    meter: Meter;
    dimension: string;
    hour: Date;
    quantity: number;
    status: ReportStatus;
    duplicate?: boolean;
    meteringRecordId?: string;
    attempts: number;
    /** Set once an attempt failed in a way that leaves open whether AWS recorded it. */
    ambiguous?: boolean;
    nextAttemptAt: Date;
    lastError?: string;
    createdAt: Date;
    acceptedAt?: Date;
}

export interface ReporterStats {
    planned: number;
    requests: number;
    failedRequests: number;
    accepted: number;
    duplicates: number;
    rejected: number;
    unprocessed: number;
    expired: number;
    unresolved: number;
}

const MAX_BATCH = 25;
/** Immediate retries within one run, before leaving the rest to the next run. */
const IN_RUN_RETRIES = 3;
const MAX_QUANTITY = 2_147_483_647;
/** AWS refuses records older than six hours; stop trying a little before that and re-plan the units. */
const EXPIRE_AFTER_MS = 5.5 * HOUR_MS;

const emptyStats = (): ReporterStats => ({ planned: 0, requests: 0, failedRequests: 0, accepted: 0, duplicates: 0, rejected: 0, unprocessed: 0, expired: 0, unresolved: 0 });

/**
 * Reports usage of marketplace-billed orgs to AWS Marketplace once per closed hour.
 *
 * AWS only takes whole units per customer, dimension and hour, so each run
 * reports floor(total usage so far) minus everything already reported or in
 * flight. Fractions carry over to later hours, late usage for any earlier hour
 * lands in the next report, and a crashed or repeated run reports nothing twice.
 */
export class MarketplaceReporter {
    private readonly db: Database;
    private readonly client: MeteringClient;
    private readonly clock: Clock;
    private readonly usage: UsageQuery;
    private readonly audit: AuditLog;
    private readonly logger: Logger;
    private readonly retryDelayMs: number;

    constructor(deps: { db: Database; client: MeteringClient; clock: Clock; usage: UsageQuery; audit: AuditLog; logger?: Logger; retryDelayMs?: number }) {
        this.retryDelayMs = deps.retryDelayMs ?? 50;
        this.db = deps.db;
        this.client = deps.client;
        this.clock = deps.clock;
        this.usage = deps.usage;
        this.audit = deps.audit;
        this.logger = deps.logger ?? silentLogger;
    }

    private get reports() {
        return this.db.db.collection<MarketplaceReport>("marketplace_reports");
    }

    async ensureIndexes(): Promise<void> {
        await this.reports.createIndex({ status: 1, nextAttemptAt: 1 });
        await this.reports.createIndex({ orgId: 1, meter: 1, status: 1 });
    }

    async runOnce(): Promise<ReporterStats> {
        const stats = emptyStats();
        Object.assign(stats, await this.expireStale());
        const orgs = await this.db.orgs.find({ "billing.channel": "aws_marketplace" }).toArray();
        for (const org of orgs) stats.planned += await this.plan(org);
        await this.send(stats);
        if (stats.requests > 0 || stats.planned > 0) this.logger.info("marketplace report run", { ...stats });
        return stats;
    }

    async plan(org: Org): Promise<number> {
        if (org.billing.channel !== "aws_marketplace") return 0;
        const cutoff = startOfHour(new Date(this.clock.now().getTime() - HOUR_CLOSE_GRACE_MS));
        const reportHour = new Date(cutoff.getTime() - HOUR_MS);
        const since = org.plans[0]?.effectiveFrom ?? org.createdAt;
        if (reportHour < since) return 0;
        const totals = await this.usage.totals(org._id, since, cutoff);
        const reported = await this.reports
            .aggregate<{ _id: Meter; quantity: number }>([
                // Rejected units are not re-planned either: AWS would reject them again every hour.
                { $match: { orgId: org._id, status: { $in: ["pending", "accepted", "rejected", "unresolved"] } } },
                { $group: { _id: "$meter", quantity: { $sum: "$quantity" } } },
            ])
            .toArray();
        const already = new Map(reported.map((r) => [r._id, BigInt(r.quantity)]));
        let planned = 0;
        for (const meter of METERS) {
            const delta = totals[meter] / QTY_SCALE - (already.get(meter) ?? 0n);
            if (delta < 0n) {
                this.logger.warn("reported more than metered", { orgId: org._id, meter, delta });
                continue;
            }
            if (delta === 0n) continue;
            const quantity = Number(delta > BigInt(MAX_QUANTITY) ? BigInt(MAX_QUANTITY) : delta);
            const doc: MarketplaceReport = {
                _id: `${org._id}|${DIMENSIONS[meter]}|${reportHour.toISOString()}`,
                orgId: org._id,
                productCode: org.billing.productCode,
                customerIdentifier: org.billing.customerIdentifier,
                meter,
                dimension: DIMENSIONS[meter],
                hour: reportHour,
                quantity,
                status: "pending",
                attempts: 0,
                nextAttemptAt: this.clock.now(),
                createdAt: this.clock.now(),
            };
            try {
                await this.reports.insertOne(doc);
                planned++;
            } catch (error) {
                // This hour already has a report; the remaining units go out with the next hour.
                if ((error as { code?: number }).code !== 11000) throw error;
            }
        }
        return planned;
    }

    private async expireStale(): Promise<{ expired: number; unresolved: number }> {
        const limit = new Date(this.clock.now().getTime() - EXPIRE_AFTER_MS);
        const unresolved = await this.reports.updateMany({ status: "pending", hour: { $lt: limit }, ambiguous: true }, { $set: { status: "unresolved" } });
        if (unresolved.modifiedCount > 0) this.logger.warn("marketplace reports need manual reconciliation", { count: unresolved.modifiedCount });
        const expired = await this.reports.updateMany({ status: "pending", hour: { $lt: limit } }, { $set: { status: "expired", lastError: "too old for AWS; units re-planned" } });
        return { expired: expired.modifiedCount, unresolved: unresolved.modifiedCount };
    }

    private async send(stats: ReporterStats): Promise<void> {
        const due = await this.reports.find({ status: "pending", nextAttemptAt: { $lte: this.clock.now() } }).sort({ hour: 1 }).limit(1000).toArray();
        const byProduct = new Map<string, MarketplaceReport[]>();
        for (const r of due) byProduct.set(r.productCode, [...(byProduct.get(r.productCode) ?? []), r]);
        for (const [productCode, reports] of byProduct) {
            for (let i = 0; i < reports.length; i += MAX_BATCH) await this.sendBatch(productCode, reports.slice(i, i + MAX_BATCH), stats);
        }
    }

    private async sendBatch(productCode: string, batch: MarketplaceReport[], stats: ReporterStats): Promise<void> {
        let remaining = batch;
        for (let attempt = 0; remaining.length > 0; attempt++) {
            const outcome = await this.attempt(productCode, remaining, stats);
            remaining = outcome.retry;
            if (remaining.length === 0) return;
            if (attempt === IN_RUN_RETRIES) {
                await this.backoff(remaining, outcome.reason, false);
                return;
            }
            await new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** attempt));
        }
    }

    /** One BatchMeterUsage call. Returns the reports to try again. */
    private async attempt(productCode: string, batch: MarketplaceReport[], stats: ReporterStats): Promise<{ retry: MarketplaceReport[]; reason: string }> {
        const key = (r: { customerIdentifier: string; dimension: string; timestamp: Date }) => `${r.customerIdentifier}|${r.dimension}|${Math.floor(r.timestamp.getTime() / 1000)}`;
        const byKey = new Map(batch.map((r) => [key({ ...r, timestamp: r.hour }), r]));
        const records: MeterRecord[] = batch.map((r) => ({ customerIdentifier: r.customerIdentifier, dimension: r.dimension, quantity: r.quantity, timestamp: r.hour }));
        stats.requests++;
        let response: Awaited<ReturnType<MeteringClient["batchMeterUsage"]>>;
        try {
            response = await this.client.batchMeterUsage(productCode, records);
        } catch (error) {
            stats.failedRequests++;
            const reason = String((error as Error).name ?? error);
            // Persist the doubt before retrying: if the process dies now, expiry must not re-plan these units.
            if (mayHaveBeenRecorded(error)) await this.reports.updateMany({ _id: { $in: batch.map((r) => r._id) } }, { $set: { ambiguous: true, lastError: reason } });
            return { retry: batch, reason };
        }
        const now = this.clock.now();
        const audit: AuditInput[] = [];
        await inTransaction(this.db, async (session) => {
            audit.length = 0;
            for (const result of response.results) {
                const report = byKey.get(key(result.record));
                if (!report) continue;
                if (result.status === "CustomerNotSubscribed") {
                    await this.reports.updateOne({ _id: report._id }, { $set: { status: "rejected", lastError: "CustomerNotSubscribed" }, $inc: { attempts: 1 } }, { session });
                    continue;
                }
                const duplicate = result.status === "DuplicateRecord";
                await this.reports.updateOne(
                    { _id: report._id, status: "pending" },
                    { $set: { status: "accepted", duplicate, acceptedAt: now, ...(result.meteringRecordId ? { meteringRecordId: result.meteringRecordId } : {}) }, $inc: { attempts: 1 } },
                    { session },
                );
                audit.push({
                    actor: "marketplace-reporter",
                    action: "marketplace.usage_reported",
                    entityType: "marketplace_report",
                    entityId: report._id,
                    orgId: report.orgId,
                    data: { dimension: report.dimension, quantity: report.quantity, hour: report.hour, meteringRecordId: result.meteringRecordId, duplicate },
                });
            }
            await this.audit.append(session, audit);
        });
        for (const result of response.results) {
            if (result.status === "CustomerNotSubscribed") stats.rejected++;
            else if (result.status === "DuplicateRecord") stats.duplicates++;
            else stats.accepted++;
        }
        const unprocessed = response.unprocessed.map((r) => byKey.get(key(r))).filter((r): r is MarketplaceReport => r !== undefined);
        stats.unprocessed += unprocessed.length;
        return { retry: unprocessed, reason: "UnprocessedRecords" };
    }

    private async backoff(reports: MarketplaceReport[], reason: string, ambiguous: boolean): Promise<void> {
        const now = this.clock.now().getTime();
        for (const r of reports) {
            const delayMs = Math.min(15 * 60_000, 2 ** r.attempts * 5_000);
            await this.reports.updateOne(
                { _id: r._id, status: "pending" },
                { $set: { nextAttemptAt: new Date(now + delayMs), lastError: reason, ...(ambiguous ? { ambiguous: true } : {}) }, $inc: { attempts: 1 } },
            );
        }
    }

    unresolved(): Promise<MarketplaceReport[]> {
        return this.reports.find({ status: "unresolved" }).toArray();
    }

    list(orgId: string, limit = 200): Promise<MarketplaceReport[]> {
        return this.reports.find({ orgId }).sort({ hour: -1 }).limit(limit).toArray();
    }
}

/** A throttle or other 4xx means AWS did not record anything; a 5xx or a network error leaves it open. */
function mayHaveBeenRecorded(error: unknown): boolean {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    return status === undefined || status >= 500;
}
