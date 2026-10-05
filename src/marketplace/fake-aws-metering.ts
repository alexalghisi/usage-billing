import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import type { Clock } from "../domain/time.ts";

// An in-memory stand-in for the AWS Marketplace Metering Service. It speaks the
// real wire protocol (awsJson1_1, X-Amz-Target: AWSMPMeteringService.BatchMeterUsage),
// so the official AWS SDK client is used against it unchanged.

export interface FaultConfig {
    /** Share of requests answered with InternalServiceErrorException before doing anything. */
    errorRate: number;
    /** Share of requests answered with ThrottlingException. */
    throttleRate: number;
    /** Share of records returned as UnprocessedRecords. */
    unprocessedRate: number;
    /** Share of requests that are processed but whose response is lost (500), so the caller retries a request that already succeeded. */
    lostResponseRate: number;
    latencyMs: number;
}

export interface MeteredRecord {
    meteringRecordId: string;
    productCode: string;
    customerIdentifier: string;
    dimension: string;
    quantity: number;
    timestamp: Date;
    receivedAt: Date;
}

interface WireRecord {
    Timestamp: number;
    CustomerIdentifier: string;
    Dimension: string;
    Quantity?: number;
}

const MAX_RECORDS = 25;
const MAX_AGE_MS = 6 * 3_600_000;
const NO_FAULTS: FaultConfig = { errorRate: 0, throttleRate: 0, unprocessedRate: 0, lostResponseRate: 0, latencyMs: 0 };

export class FakeAwsMetering {
    readonly records = new Map<string, MeteredRecord>();
    readonly subscriptions = new Map<string, Set<string>>();
    faults: FaultConfig = { ...NO_FAULTS };
    requests = 0;
    private readonly clock: Clock;
    private readonly random: () => number;

    constructor(clock: Clock, random: () => number = Math.random) {
        this.clock = clock;
        this.random = random;
    }

    subscribe(productCode: string, customerIdentifier: string): void {
        const set = this.subscriptions.get(productCode) ?? new Set<string>();
        set.add(customerIdentifier);
        this.subscriptions.set(productCode, set);
    }

    /** Total accepted quantity per customer and dimension. */
    totals(): Map<string, number> {
        const out = new Map<string, number>();
        for (const r of this.records.values()) {
            const k = `${r.customerIdentifier}|${r.dimension}`;
            out.set(k, (out.get(k) ?? 0) + r.quantity);
        }
        return out;
    }

    buildServer(): FastifyInstance {
        const app = Fastify({ logger: false });
        app.addContentTypeParser("application/x-amz-json-1.1", { parseAs: "string" }, (_req, body, done) => {
            try {
                done(null, JSON.parse(String(body)));
            } catch (error) {
                done(error as Error, undefined);
            }
        });
        app.post("/", async (req, reply) => {
            const target = req.headers["x-amz-target"];
            if (target !== "AWSMPMeteringService.BatchMeterUsage") return awsError(reply, 400, "UnknownOperationException", `unsupported target ${String(target)}`);
            return this.batchMeterUsage(req.body as { ProductCode?: string; UsageRecords?: WireRecord[] }, reply);
        });
        app.get("/__records", async () => ({
            records: [...this.records.values()].map((r) => ({ ...r, timestamp: r.timestamp.toISOString(), receivedAt: r.receivedAt.toISOString() })),
        }));
        app.put("/__faults", async (req) => {
            this.faults = { ...NO_FAULTS, ...(req.body as Partial<FaultConfig>) };
            return this.faults;
        });
        return app;
    }

    private async batchMeterUsage(body: { ProductCode?: string; UsageRecords?: WireRecord[] }, reply: FastifyReply) {
        this.requests++;
        if (this.faults.latencyMs > 0) await new Promise((r) => setTimeout(r, this.faults.latencyMs));
        if (this.random() < this.faults.throttleRate) return awsError(reply, 400, "ThrottlingException", "Rate exceeded");
        if (this.random() < this.faults.errorRate) return awsError(reply, 500, "InternalServiceErrorException", "An internal error occurred");

        const productCode = body.ProductCode ?? "";
        const records = body.UsageRecords ?? [];
        if (!this.subscriptions.has(productCode)) return awsError(reply, 400, "InvalidProductCodeException", "Invalid product code");
        if (records.length === 0 || records.length > MAX_RECORDS) return awsError(reply, 400, "InvalidUsageDimensionException", `UsageRecords must contain 1-${MAX_RECORDS} records`);
        const now = this.clock.now().getTime();
        for (const r of records) {
            const ts = r.Timestamp * 1000;
            if (ts > now + 60_000 || ts < now - MAX_AGE_MS) return awsError(reply, 400, "TimestampOutOfBoundsException", "Timestamp must be within the past 6 hours");
            const q = r.Quantity ?? 0;
            if (!Number.isInteger(q) || q < 0 || q > 2_147_483_647) return awsError(reply, 400, "InvalidQuantityException", "Quantity must be an integer between 0 and 2147483647");
        }

        const Results: { UsageRecord: WireRecord; MeteringRecordId?: string; Status: string }[] = [];
        const UnprocessedRecords: WireRecord[] = [];
        for (const r of records) {
            if (this.random() < this.faults.unprocessedRate) {
                UnprocessedRecords.push(r);
                continue;
            }
            if (!this.subscriptions.get(productCode)?.has(r.CustomerIdentifier)) {
                Results.push({ UsageRecord: r, Status: "CustomerNotSubscribed" });
                continue;
            }
            // AWS keeps one record per customer, dimension and hour; a repeat returns the original id.
            const key = `${productCode}|${r.CustomerIdentifier}|${r.Dimension}|${Math.floor(r.Timestamp / 3600)}`;
            const existing = this.records.get(key);
            if (existing) {
                Results.push({ UsageRecord: r, MeteringRecordId: existing.meteringRecordId, Status: "DuplicateRecord" });
                continue;
            }
            const meteringRecordId = randomUUID();
            this.records.set(key, {
                meteringRecordId,
                productCode,
                customerIdentifier: r.CustomerIdentifier,
                dimension: r.Dimension,
                quantity: r.Quantity ?? 0,
                timestamp: new Date(r.Timestamp * 1000),
                receivedAt: this.clock.now(),
            });
            Results.push({ UsageRecord: r, MeteringRecordId: meteringRecordId, Status: "Success" });
        }
        if (this.random() < this.faults.lostResponseRate) return awsError(reply, 500, "InternalServiceErrorException", "response lost");
        void reply.header("content-type", "application/x-amz-json-1.1");
        return { Results, UnprocessedRecords };
    }
}

function awsError(reply: FastifyReply, status: number, type: string, message: string) {
    return reply.status(status).header("x-amzn-errortype", type).header("content-type", "application/x-amz-json-1.1").send({ __type: type, message });
}
