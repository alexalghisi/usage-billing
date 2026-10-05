import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/time.ts";
import { createUsageHandler, type IngestStats } from "../../src/metering/handler.ts";
import { recordId } from "../../src/metering/record.ts";
import { MemoryUsageStore } from "../helpers/memory-usage-store.ts";
import { sqsEvent, sqsRecord } from "../helpers/sqs-event.ts";

const clock = new FixedClock(new Date("2026-09-15T12:00:00Z"));

function rec(eventId: string, patch: Record<string, string> = {}) {
    return { eventId, orgId: "org_a", serviceId: "svc_1", meter: "compute", quantity: "1.5", timestamp: "2026-09-15T10:30:00Z", ...patch };
}

function setup() {
    const store = new MemoryUsageStore();
    const stats: IngestStats[] = [];
    const handler = createUsageHandler({ store, clock, onStats: (s) => stats.push(s) });
    return { store, handler, stats };
}

describe("usage handler", () => {
    it("writes valid records and marks their org-hours dirty", async () => {
        const { store, handler } = setup();
        const res = await handler(sqsEvent({ records: [rec("1"), rec("2", { timestamp: "2026-09-15T11:59:59Z" })] }));
        expect(res.batchItemFailures).toEqual([]);
        expect(store.records.size).toBe(2);
        expect([...store.dirty].sort()).toEqual(["org_a|2026-09-15T10:00:00.000Z", "org_a|2026-09-15T11:00:00.000Z"]);
    });

    it("is idempotent across redeliveries", async () => {
        const { store, handler, stats } = setup();
        const body = { records: [rec("1"), rec("2")] };
        await handler(sqsEvent(body));
        await handler(sqsEvent(body));
        expect(store.records.size).toBe(2);
        expect(stats[1]).toMatchObject({ inserted: 0, duplicates: 2 });
    });

    it("acknowledges and parks malformed input instead of retrying it forever", async () => {
        const { store, handler } = setup();
        const res = await handler(sqsEvent("not json", { nope: true }, { records: [rec("1"), rec("2", { quantity: "abc" })] }));
        expect(res.batchItemFailures).toEqual([]);
        expect(store.records.size).toBe(1);
        expect(store.rejected.map((r) => r.reason)).toEqual(["body: not JSON", expect.stringMatching(/expected \{records/), expect.stringMatching(/^quantity/)]);
    });

    it("reports only the messages whose records could not be stored", async () => {
        const { store, handler } = setup();
        const bad = rec("2");
        store.failRecordIds.add(recordId({ ...bad, meter: "compute" }));
        const ok = sqsRecord({ records: [rec("1")] }, "ok");
        const failing = sqsRecord({ records: [bad, rec("3")] }, "failing");
        const res = await handler({ Records: [ok, failing] });
        expect(res.batchItemFailures).toEqual([{ itemIdentifier: "failing" }]);
        // rec 3 was stored; the retry of the whole message will see it as a duplicate.
        expect(store.records.size).toBe(2);
    });

    it("fails every message with records when the database is unavailable", async () => {
        const { store, handler } = setup();
        store.failInsert = true;
        const res = await handler({ Records: [sqsRecord({ records: [rec("1")] }, "a"), sqsRecord("garbage", "b")] });
        expect(res.batchItemFailures).toEqual([{ itemIdentifier: "a" }]);
        expect(store.rejected).toHaveLength(1);
    });

    it("retries when marking dirty hours fails, and the retry repairs the marker", async () => {
        const { store, handler } = setup();
        store.failMarkDirty = true;
        const body = { records: [rec("1")] };
        const first = await handler({ Records: [sqsRecord(body, "x")] });
        expect(first.batchItemFailures).toEqual([{ itemIdentifier: "x" }]);
        expect(store.records.size).toBe(1);
        expect(store.dirty.size).toBe(0);
        store.failMarkDirty = false;
        const retry = await handler({ Records: [sqsRecord(body, "x")] });
        expect(retry.batchItemFailures).toEqual([]);
        expect(store.dirty.size).toBe(1);
    });

    it("retries rejections it could not park", async () => {
        const { store, handler } = setup();
        store.failReject = true;
        const res = await handler({ Records: [sqsRecord("garbage", "g")] });
        expect(res.batchItemFailures).toEqual([{ itemIdentifier: "g" }]);
    });

    it("parks a reused event id with a different payload as a conflict", async () => {
        const { store, handler } = setup();
        await handler(sqsEvent({ records: [rec("1")] }));
        const res = await handler(sqsEvent({ records: [rec("1", { quantity: "99" })] }));
        expect(res.batchItemFailures).toEqual([]);
        expect(store.rejected[0]?.reason).toMatch(/conflicting duplicate/);
        expect(store.records.size).toBe(1);
    });

    it("writes only one copy of a record repeated within a batch", async () => {
        const { store, handler, stats } = setup();
        await handler(sqsEvent({ records: [rec("1")] }, { records: [rec("1")] }));
        expect(store.records.size).toBe(1);
        expect(stats[0]).toMatchObject({ inserted: 1, duplicates: 1 });
    });
});
