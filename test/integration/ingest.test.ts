import { GetQueueAttributesCommand, SendMessageCommand } from "@aws-sdk/client-sqs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { METERS } from "../../src/domain/meters.ts";
import { FixedClock } from "../../src/domain/time.ts";
import type { Database } from "../../src/infra/mongo.ts";
import { createUsageHandler } from "../../src/metering/handler.ts";
import { MongoUsageStore } from "../../src/metering/mongo-usage-store.ts";
import { SqsPoller } from "../../src/metering/poller.ts";
import { UsagePublisher } from "../../src/metering/producer.ts";
import { validateRecord, type UsageRecordInput } from "../../src/metering/record.ts";
import type { UsageStore } from "../../src/metering/usage-store.ts";
import { testDatabase, testQueue } from "../helpers/env.ts";

const clock = new FixedClock(new Date("2026-09-15T12:00:00Z"));

function records(n: number, org = "org_a"): UsageRecordInput[] {
    return Array.from({ length: n }, (_, i) => ({
        eventId: `ev-${i}`,
        orgId: org,
        serviceId: `svc_${i % 3}`,
        meter: METERS[i % 3] ?? "compute",
        quantity: `${(i % 7) + 1}.25`,
        timestamp: new Date(Date.UTC(2026, 8, 15, i % 12, i % 60)).toISOString(),
    }));
}

async function queueDepth(sqs: Awaited<ReturnType<typeof testQueue>>["sqs"], url: string): Promise<number> {
    const res = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"] }));
    return Number(res.Attributes?.ApproximateNumberOfMessages ?? 0) + Number(res.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}

async function drain(poller: SqsPoller, isDone: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await isDone())) {
        if (Date.now() > deadline) throw new Error("queue did not drain");
        if ((await poller.pollOnce()) === 0) await new Promise((r) => setTimeout(r, 100));
    }
}

describe("MongoUsageStore", () => {
    let db: Database;
    beforeAll(async () => (db = await testDatabase("store")));
    afterAll(async () => {
        await db.drop();
        await db.client.close();
    });

    it("inserts once, reports duplicates and conflicts by position", async () => {
        const store = new MongoUsageStore(db);
        const [a, b] = records(2).map((r) => {
            const v = validateRecord(r, clock);
            if (!v.ok) throw new Error(v.reason);
            return v.record;
        });
        if (!a || !b) throw new Error("setup");
        expect(await store.insert([a])).toEqual(["inserted"]);
        const changed = { ...a, quantity: a.quantity + 1n, payloadHash: "different" };
        expect(await store.insert([b, a, changed])).toEqual(["inserted", "duplicate", "conflict"]);
        expect(await db.usageRecords.countDocuments()).toBe(2);
        const stored = await db.usageRecords.findOne({ _id: a._id });
        expect(typeof stored?.quantity).toBe("bigint");
        expect(stored?.quantity).toBe(a.quantity);
    });
});

describe("ingestion through SQS", () => {
    let db: Database;
    beforeAll(async () => (db = await testDatabase("ingest")));
    afterAll(async () => {
        await db.drop();
        await db.client.close();
    });

    it("stores every record exactly once despite resends, poison messages and a flaky database", async () => {
        const q = await testQueue("ingest", 10);
        const real = new MongoUsageStore(db);
        let insertCalls = 0;
        // Every third insert call fails before writing, as if the primary stepped down.
        const flaky: UsageStore = {
            insert: (rs) => (++insertCalls % 3 === 0 ? Promise.reject(new Error("not primary")) : real.insert(rs)),
            markDirty: (keys) => real.markDirty(keys),
            reject: (rs) => real.reject(rs),
        };
        const handler = createUsageHandler({ store: flaky, clock });
        const poller = new SqsPoller({ sqs: q.sqs, queueUrl: q.queueUrl, queueArn: q.queueArn, handler, batchSize: 30, retryDelaySeconds: 0 });
        const publisher = new UsagePublisher(q.sqs, q.queueUrl, 20);

        const input = records(2000);
        await publisher.publish(input);
        await publisher.publish(input.slice(0, 300)); // producer resends after a timeout
        await q.sqs.send(new SendMessageCommand({ QueueUrl: q.queueUrl, MessageBody: "{broken" }));

        await drain(poller, async () => (await queueDepth(q.sqs, q.queueUrl)) === 0);

        expect(await db.usageRecords.countDocuments()).toBe(2000);
        const [total] = await db.usageRecords.aggregate<{ q: bigint }>([{ $group: { _id: null, q: { $sum: "$quantity" } } }]).toArray();
        const expected = input.reduce((acc, r) => acc + BigInt(r.quantity.replace(".", "")) * 10_000n, 0n);
        expect(total?.q).toBe(expected);
        expect(await db.rejectedRecords.countDocuments({ reason: "body: not JSON" })).toBe(1);
        expect(await db.dirtyHours.countDocuments({ orgId: "org_a" })).toBe(12);
        expect(insertCalls).toBeGreaterThan(3);
        expect(await queueDepth(q.sqs, q.dlqUrl)).toBe(0);
    });

    it("moves a message that keeps failing to the dead-letter queue", async () => {
        const q = await testQueue("dlq", 2);
        const handler = createUsageHandler({
            store: { insert: () => Promise.reject(new Error("down")), markDirty: async () => {}, reject: async () => {} },
            clock,
        });
        const poller = new SqsPoller({ sqs: q.sqs, queueUrl: q.queueUrl, queueArn: q.queueArn, handler, retryDelaySeconds: 0 });
        await new UsagePublisher(q.sqs, q.queueUrl).publish(records(1));
        await drain(poller, async () => (await queueDepth(q.sqs, q.dlqUrl)) === 1);
        expect(await queueDepth(q.sqs, q.queueUrl)).toBe(0);
    });
});
