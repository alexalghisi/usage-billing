import { describe, expect, it } from "vitest";
import { FixedClock } from "../../src/domain/time.ts";
import { recordId, validateRecord } from "../../src/metering/record.ts";

const clock = new FixedClock(new Date("2026-09-15T12:00:00Z"));
const base = { eventId: "e-1", orgId: "org_a", serviceId: "svc_1", meter: "compute", quantity: "60", timestamp: "2026-09-15T11:15:00Z" };

describe("validateRecord", () => {
    it("normalizes a valid record", () => {
        const result = validateRecord(base, clock);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.record.quantity).toBe(60_000_000n);
        expect(result.record.hour.toISOString()).toBe("2026-09-15T11:00:00.000Z");
        expect(result.record._id).toBe(recordId(base as Parameters<typeof recordId>[0]));
    });

    it.each([
        [{ meter: "cpu" }, /meter/],
        [{ quantity: 60 }, /quantity/],
        [{ quantity: "-1" }, /quantity/],
        [{ quantity: "1.1234567" }, /quantity/],
        [{ timestamp: "2026-09-15 11:15" }, /timestamp/],
        [{ timestamp: "2026-09-15T13:00:00Z" }, /future/],
        [{ timestamp: "2024-01-01T00:00:00Z" }, /retention/],
        [{ orgId: "org a" }, /orgId/],
        [{ eventId: "" }, /eventId/],
    ])("rejects %j", (patch, reason) => {
        const result = validateRecord({ ...base, ...patch }, clock);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toMatch(reason);
    });

    it("derives the same id for the same event and a different id for another org", () => {
        expect(recordId(base as Parameters<typeof recordId>[0])).toBe(recordId({ ...base, meter: "compute" }));
        expect(recordId({ ...base, meter: "compute", orgId: "org_b" })).not.toBe(recordId({ ...base, meter: "compute" }));
    });

    it("gives the same record id but a different payload hash when the quantity differs", () => {
        const a = validateRecord(base, clock);
        const b = validateRecord({ ...base, quantity: "61" }, clock);
        if (!a.ok || !b.ok) throw new Error("expected valid");
        expect(a.record._id).toBe(b.record._id);
        expect(a.record.payloadHash).not.toBe(b.record.payloadHash);
    });
});
