import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { zeroQuantities } from "../../src/domain/meters.ts";
import { monthPeriod } from "../../src/domain/time.ts";
import { parseFixed } from "../../src/money/fixed.ts";
import { defaultCatalog } from "../../src/rating/catalog.ts";
import { discountFor, prorateFee, rateSegments } from "../../src/rating/rate.ts";
import { planSegments } from "../../src/rating/segments.ts";

const sep = monthPeriod("2026-09");
const u = (compute: string, storage = "0", transfer = "0") => ({
    compute: parseFixed(compute, 6),
    storage: parseFixed(storage, 6),
    transfer: parseFixed(transfer, 6),
});

describe("prorateFee", () => {
    it("charges the full fee for the full period", () => {
        expect(prorateFee(9_900n, sep.start, sep.end, sep)).toBe(9_900n);
    });

    it("charges by elapsed time", () => {
        // 10 of 30 days of $99.00
        expect(prorateFee(9_900n, sep.start, new Date("2026-09-11T00:00:00Z"), sep)).toBe(3_300n);
    });

    it("any split of the period adds up to exactly the fee", () => {
        const hours = (sep.end.getTime() - sep.start.getTime()) / 3_600_000;
        fc.assert(
            fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.uniqueArray(fc.integer({ min: 1, max: hours - 1 }), { maxLength: 8 }), (fee, cuts) => {
                const points = [0, ...[...cuts].sort((a, b) => a - b), hours].map((h) => new Date(sep.start.getTime() + h * 3_600_000));
                let total = 0n;
                for (let i = 0; i + 1 < points.length; i++) total += prorateFee(fee, points[i] as Date, points[i + 1] as Date, sep);
                expect(total).toBe(fee);
            }),
        );
    });
});

describe("planSegments", () => {
    it("covers the period from the plan in force at its start", () => {
        const segs = planSegments([{ planId: "developer", effectiveFrom: new Date("2026-05-01T00:00:00Z") }], sep);
        expect(segs).toEqual([{ planId: "developer", from: sep.start, to: sep.end }]);
    });

    it("splits at an upgrade and starts at a mid-period signup", () => {
        const segs = planSegments(
            [
                { planId: "scale", effectiveFrom: new Date("2026-09-21T00:00:00Z") },
                { planId: "developer", effectiveFrom: new Date("2026-09-06T00:00:00Z") },
            ],
            sep,
        );
        expect(segs.map((s) => [s.planId, s.from.toISOString().slice(0, 10), s.to.toISOString().slice(0, 10)])).toEqual([
            ["developer", "2026-09-06", "2026-09-21"],
            ["scale", "2026-09-21", "2026-10-01"],
        ]);
    });

    it("merges consecutive changes to the same plan and ignores future changes", () => {
        const segs = planSegments(
            [
                { planId: "scale", effectiveFrom: new Date("2026-08-01T00:00:00Z") },
                { planId: "scale", effectiveFrom: new Date("2026-09-10T00:00:00Z") },
                { planId: "enterprise", effectiveFrom: new Date("2026-11-01T00:00:00Z") },
            ],
            sep,
        );
        expect(segs).toEqual([{ planId: "scale", from: sep.start, to: sep.end }]);
    });

    it("rejects changes that are not on an hour boundary", () => {
        expect(() => planSegments([{ planId: "scale", effectiveFrom: new Date("2026-09-10T10:30:00Z") }], sep)).toThrow(/hour-aligned/);
    });
});

describe("rateSegments", () => {
    it("rates a full month on one plan", () => {
        const lines = rateSegments(sep, [{ planId: "scale", from: sep.start, to: sep.end, usage: u("250000", "36000", "100") }], defaultCatalog);
        expect(lines.map((l) => [l.id, l.amount])).toEqual([
            ["base:0", 9_900n],
            ["usage:compute:0", 82_500n], // 100k x 0.0036 + 150k x 0.0031
            ["usage:storage:0", 144n], // volume: 36,000 GB-h x 0.00004 = 1.44
            ["usage:transfer:0", 850n], // 100 GB x 0.085
        ]);
        expect(lines[1]?.description).toBe("Compute: 250,000 compute-unit-minutes");
    });

    it("prorates the base fee and the tier allowances on a mid-cycle upgrade", () => {
        const change = new Date("2026-09-11T00:00:00Z"); // developer for 10 days, scale for 20
        const lines = rateSegments(
            sep,
            [
                { planId: "developer", from: sep.start, to: change, usage: u("3000") },
                { planId: "scale", from: change, to: sep.end, usage: u("70000") },
            ],
            defaultCatalog,
        );
        const byId = new Map(lines.map((l) => [l.id, l]));
        // The developer free allowance is 6,000 unit-minutes a month, 2,000 for a third of it.
        // 1,000 billable at 0.0042 = 4.20
        expect(byId.get("usage:compute:0")?.amount).toBe(420n);
        expect(byId.get("base:1")?.amount).toBe(6_600n); // 20/30 of $99
        // Scale's first band is 100,000 a month, 66,666.666666 for two thirds: 66,666.666666 x 0.0036 + 3,333.333334 x 0.0031
        expect(byId.get("usage:compute:1")?.amount).toBe(24_000n + 1_033n);
        expect(byId.get("usage:compute:1")?.description).toMatch(/\(2026-09-11 to 2026-09-30\)$/);
    });

    it("produces zero-amount usage lines when there is no usage", () => {
        const lines = rateSegments(sep, [{ planId: "developer", from: sep.start, to: sep.end, usage: zeroQuantities() }], defaultCatalog);
        expect(lines.every((l) => l.amount === 0n)).toBe(true);
    });

    it("discounts usage but not the base fee", () => {
        const lines = rateSegments(sep, [{ planId: "scale", from: sep.start, to: sep.end, usage: u("250000") }], defaultCatalog);
        expect(discountFor(lines, 1_000)).toBe(8_250n);
        expect(discountFor(lines, 0)).toBe(0n);
    });
});
