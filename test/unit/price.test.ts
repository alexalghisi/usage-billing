import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseFixed } from "../../src/money/fixed.ts";
import { exactToCents } from "../../src/money/money.ts";
import { scale } from "../../src/rating/catalog.ts";
import type { MeterPricing } from "../../src/rating/plan.ts";
import { priceUsage, prorateTiers } from "../../src/rating/price.ts";

const q = (s: string) => parseFixed(s, 6);
const p = (s: string) => parseFixed(s, 9);

const tiered: MeterPricing = {
    model: "tiered",
    tiers: [
        { upTo: q("100"), unitPrice: p("1") },
        { upTo: q("1000"), unitPrice: p("0.5") },
        { upTo: null, unitPrice: p("0.25") },
    ],
};
const volume: MeterPricing = { ...tiered, model: "volume" };

const arbPricing: fc.Arbitrary<MeterPricing> = fc
    .tuple(
        fc.constantFrom("tiered" as const, "volume" as const),
        fc.uniqueArray(fc.bigInt({ min: 1n, max: 10n ** 12n }), { minLength: 0, maxLength: 4 }),
        fc.array(fc.bigInt({ min: 0n, max: 10n ** 7n }), { minLength: 5, maxLength: 5 }),
    )
    .map(([model, bounds, prices]) => {
        const sorted = [...bounds].sort((a, b) => (a < b ? -1 : 1));
        return { model, tiers: [...sorted.map((upTo, i) => ({ upTo, unitPrice: prices[i] ?? 0n })), { upTo: null, unitPrice: prices[4] ?? 0n }] };
    });
const arbQty = fc.bigInt({ min: 0n, max: 10n ** 13n });

describe("tiered pricing", () => {
    it("charges each band at its own price", () => {
        const charge = priceUsage(q("1500"), tiered);
        // 100 x 1 + 900 x 0.5 + 500 x 0.25 = 675
        expect(exactToCents(charge.exact)).toBe(67_500n);
        expect(charge.tiers.map((t) => t.quantity)).toEqual([q("100"), q("900"), q("500")]);
    });

    it("stops at the band the quantity reaches, boundaries inclusive", () => {
        expect(priceUsage(q("100"), tiered).tiers).toHaveLength(1);
        expect(exactToCents(priceUsage(q("100.000001"), tiered).exact)).toBe(10_000n);
        expect(priceUsage(0n, tiered)).toEqual({ exact: 0n, tiers: [] });
    });

    it("matches the published Scale compute example", () => {
        // 250,000 unit-minutes: 100k x 0.0036 + 150k x 0.0031 = 360 + 465
        expect(exactToCents(priceUsage(q("250000"), scale.meters.compute).exact)).toBe(82_500n);
    });

    it("is additive: pricing a + b equals pricing a plus the marginal price of b", () => {
        fc.assert(
            fc.property(arbPricing.filter((x) => x.model === "tiered"), arbQty, arbQty, (pricing, a, b) => {
                const total = priceUsage(a + b, pricing).exact;
                const parts = priceUsage(a, pricing).exact;
                // marginal price of b on top of a, computed unit band by band
                let marginal = 0n;
                let from = 0n;
                for (const t of pricing.tiers) {
                    const lo = a > from ? a : from;
                    const hi = t.upTo === null || a + b < t.upTo ? a + b : t.upTo;
                    if (hi > lo) marginal += (hi - lo) * t.unitPrice;
                    if (t.upTo === null) break;
                    from = t.upTo;
                }
                expect(total).toBe(parts + marginal);
            }),
        );
    });

    it("never decreases when usage grows", () => {
        fc.assert(
            fc.property(arbPricing.filter((x) => x.model === "tiered"), arbQty, arbQty, (pricing, a, extra) => {
                expect(priceUsage(a + extra, pricing).exact >= priceUsage(a, pricing).exact).toBe(true);
            }),
        );
    });

    it("tier quantities always add up to the total quantity", () => {
        fc.assert(
            fc.property(arbPricing, arbQty, (pricing, quantity) => {
                const charge = priceUsage(quantity, pricing);
                expect(charge.tiers.reduce((acc, t) => acc + t.quantity, 0n)).toBe(quantity);
                expect(charge.tiers.reduce((acc, t) => acc + t.exact, 0n)).toBe(charge.exact);
            }),
        );
    });
});

describe("volume pricing", () => {
    it("charges all units at the price of the band the total falls into", () => {
        expect(exactToCents(priceUsage(q("1500"), volume).exact)).toBe(37_500n);
        expect(exactToCents(priceUsage(q("1000"), volume).exact)).toBe(50_000n);
        expect(exactToCents(priceUsage(q("100"), volume).exact)).toBe(10_000n);
    });

    it("always equals quantity times exactly one tier price", () => {
        fc.assert(
            fc.property(arbPricing.filter((x) => x.model === "volume"), arbQty, (pricing, quantity) => {
                const charge = priceUsage(quantity, pricing);
                expect(charge.tiers).toHaveLength(1);
                expect(pricing.tiers.some((t) => t.unitPrice * quantity === charge.exact)).toBe(true);
            }),
        );
    });
});

describe("prorateTiers", () => {
    it("scales bounds and keeps prices", () => {
        const half = prorateTiers(tiered, 1n, 2n);
        expect(half.tiers.map((t) => t.upTo)).toEqual([q("50"), q("500"), null]);
        expect(half.tiers.map((t) => t.unitPrice)).toEqual(tiered.tiers.map((t) => t.unitPrice));
    });

    it("is the identity for the whole period", () => {
        fc.assert(
            fc.property(arbPricing, fc.bigInt({ min: 1n, max: 10n ** 10n }), (pricing, n) => {
                expect(prorateTiers(pricing, n, n)).toBe(pricing);
            }),
        );
    });

    it("never charges less under a shorter allowance for tiered prices that decrease", () => {
        fc.assert(
            fc.property(arbQty, fc.bigInt({ min: 1n, max: 999n }), (quantity, num) => {
                const full = priceUsage(quantity, tiered).exact;
                const partial = priceUsage(quantity, prorateTiers(tiered, num, 1000n)).exact;
                expect(partial <= full).toBe(true);
            }),
        );
    });
});
