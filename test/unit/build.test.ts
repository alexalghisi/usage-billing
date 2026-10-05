import { describe, expect, it } from "vitest";
import { zeroQuantities } from "../../src/domain/meters.ts";
import { monthPeriod } from "../../src/domain/time.ts";
import { computeCharges, withTax } from "../../src/invoicing/build.ts";
import { parseFixed } from "../../src/money/fixed.ts";
import type { Org } from "../../src/orgs/org.ts";
import { defaultCatalog } from "../../src/rating/catalog.ts";
import type { CreditGrant } from "../../src/rating/credits.ts";
import type { TaxQuote } from "../../src/tax/tax.ts";

const sep = monthPeriod("2026-09");
const org: Org = {
    _id: "org_a",
    name: "Acme",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    billing: { channel: "invoice" },
    taxProfile: { country: "IE" },
    plans: [{ planId: "scale", effectiveFrom: new Date("2026-01-01T00:00:00Z") }],
    contract: null,
};
const usage = { compute: parseFixed("250000", 6), storage: 0n, transfer: 0n };
const noTax = (taxable: bigint): TaxQuote => ({ regime: "not_taxable", jurisdiction: "XX", rateBps: 0, taxable, amount: 0n, note: "" });
const vat = (taxable: bigint): TaxQuote => ({ regime: "domestic", jurisdiction: "IE", rateBps: 2300, taxable, amount: (taxable * 23n + 50n) / 100n, note: "" });

function charges(overrides: Partial<Parameters<typeof computeCharges>[0]> = {}) {
    return computeCharges({
        org,
        periodKey: "2026-09",
        period: sep,
        segments: [{ planId: "scale", from: sep.start, to: sep.end, usage }],
        adjustments: [],
        grants: [],
        catalog: defaultCatalog,
        usageReadAt: sep.end,
        ...overrides,
    });
}

function grant(remaining: bigint): CreditGrant {
    return { _id: "g1", orgId: "org_a", kind: "trial", description: "Free trial credit", amount: remaining, remaining, effectiveAt: sep.start, expiresAt: null, createdAt: sep.start };
}

describe("computeCharges", () => {
    it("totals lines and links usage lines to their rollups", () => {
        const c = charges();
        expect(c.subtotal).toBe(9_900n + 82_500n);
        expect(c.net).toBe(c.subtotal);
        expect(c.lines.find((l) => l.id === "usage:compute:0")?.source).toEqual({ orgId: "org_a", meter: "compute", from: sep.start, to: sep.end });
        expect(c.usage).toEqual(usage);
    });

    it("applies the contract discount, then credits, then tax", () => {
        const c = charges({
            org: { ...org, contract: { commitment: 0n, discountBps: 1000, startsAt: sep.start, endsAt: new Date("2027-01-01T00:00:00Z") } },
            grants: [grant(10_000n)],
        });
        expect(c.discount).toBe(8_250n);
        expect(c.credits).toBe(10_000n);
        expect(c.taxable).toBe(92_400n - 8_250n - 10_000n);
        const inv = withTax(c, vat(c.taxable));
        expect(inv.total).toBe(74_150n + 17_055n);
        expect(inv.lines.reduce((acc, l) => acc + l.amount, 0n) + inv.tax.amount).toBe(inv.total);
    });

    it("adds an adjustment line for a re-rated earlier period", () => {
        const c = charges({
            adjustments: [{ period: "2026-08", previousUsage: zeroQuantities(), usage: { ...zeroQuantities(), compute: 1_000_000n }, previousNet: 9_900n, net: 9_901n }],
        });
        const adj = c.lines.find((l) => l.kind === "adjustment");
        expect(adj).toMatchObject({ amount: 1n, adjustsPeriod: "2026-08" });
        expect(adj?.description).toMatch(/compute \+1 compute-unit-minutes/);
        expect(c.net).toBe(92_400n);
        expect(c.subtotal).toBe(92_401n);
    });

    it("carries a negative total forward as credit instead of charging it", () => {
        const c = charges({
            segments: [{ planId: "developer", from: sep.start, to: sep.end, usage: zeroQuantities() }],
            adjustments: [{ period: "2026-08", previousUsage: usage, usage: zeroQuantities(), previousNet: 5_000n, net: 0n }],
        });
        const inv = withTax(c, noTax(c.taxable));
        expect(inv.total).toBe(-5_000n);
        expect(inv.amountDue).toBe(0n);
        expect(inv.carryForward).toBe(5_000n);
    });
});
