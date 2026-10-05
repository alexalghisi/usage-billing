import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { monthPeriod } from "../../src/domain/time.ts";
import { applyCredits, type CreditGrant, type GrantKind } from "../../src/rating/credits.ts";

const sep = monthPeriod("2026-09");

function grant(id: string, kind: GrantKind, remaining: bigint, expiresAt: string | null, effectiveAt = "2026-01-01T00:00:00Z"): CreditGrant {
    return {
        _id: id,
        orgId: "org_a",
        kind,
        description: id,
        amount: remaining,
        remaining,
        effectiveAt: new Date(effectiveAt),
        expiresAt: expiresAt ? new Date(expiresAt) : null,
        createdAt: new Date(effectiveAt),
    };
}

describe("applyCredits", () => {
    it("burns the soonest-expiring credit first, trial before prepaid", () => {
        const grants = [grant("prepaid", "prepaid", 100_000n, "2027-01-01T00:00:00Z"), grant("trial", "trial", 30_000n, "2026-09-20T00:00:00Z")];
        const { applied, remainingDue } = applyCredits(50_000n, grants, sep);
        expect(applied.map((a) => [a.grantId, a.amount])).toEqual([
            ["trial", 30_000n],
            ["prepaid", 20_000n],
        ]);
        expect(remainingDue).toBe(0n);
    });

    it("leaves the rest due when credits run out", () => {
        expect(applyCredits(50_000n, [grant("t", "trial", 10_000n, null)], sep).remainingDue).toBe(40_000n);
    });

    it("ignores expired, future and empty grants", () => {
        const grants = [
            grant("expired", "trial", 10_000n, "2026-09-01T00:00:00Z"),
            grant("future", "prepaid", 10_000n, null, "2026-10-01T00:00:00Z"),
            grant("empty", "prepaid", 0n, null),
        ];
        expect(applyCredits(5_000n, grants, sep).applied).toEqual([]);
    });

    it("does nothing for a zero or negative amount", () => {
        expect(applyCredits(0n, [grant("t", "trial", 1n, null)], sep)).toEqual({ applied: [], remainingDue: 0n });
        expect(applyCredits(-500n, [grant("t", "trial", 1n, null)], sep)).toEqual({ applied: [], remainingDue: -500n });
    });

    it("never applies more than is due or more than a grant holds", () => {
        const arbGrant = fc.record({
            kind: fc.constantFrom("trial" as const, "prepaid" as const, "balance" as const),
            remaining: fc.bigInt({ min: 0n, max: 10n ** 8n }),
            expires: fc.option(fc.integer({ min: 0, max: 90 })),
        });
        fc.assert(
            fc.property(fc.bigInt({ min: 0n, max: 10n ** 9n }), fc.array(arbGrant, { maxLength: 6 }), (due, specs) => {
                const grants = specs.map((s, i) =>
                    grant(`g${i}`, s.kind, s.remaining, s.expires === null ? null : new Date(Date.UTC(2026, 8, 1 + s.expires)).toISOString()),
                );
                const { applied, remainingDue } = applyCredits(due, grants, sep);
                const total = applied.reduce((acc, a) => acc + a.amount, 0n);
                expect(total + remainingDue).toBe(due);
                for (const a of applied) {
                    expect(a.amount > 0n).toBe(true);
                    expect(a.amount <= (grants.find((g) => g._id === a.grantId)?.remaining ?? 0n)).toBe(true);
                }
            }),
        );
    });
});
