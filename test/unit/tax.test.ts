import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { amountFor, isPlausibleVatId, StaticTaxProvider } from "../../src/tax/static-provider.ts";

const tax = new StaticTaxProvider();
const seller = { country: "IE" };
const supplyDate = new Date("2026-10-01T00:00:00Z");
const quote = (customer: { country: string; region?: string; vatId?: string }, taxable = 100_000n) => tax.quote({ seller, customer, taxable, supplyDate });

describe("StaticTaxProvider", () => {
    it("charges domestic VAT in the seller's country, VAT id or not", async () => {
        expect(await quote({ country: "IE" })).toMatchObject({ regime: "domestic", rateBps: 2300, amount: 23_000n });
        expect(await quote({ country: "IE", vatId: "IE6388047V" })).toMatchObject({ regime: "domestic", amount: 23_000n });
    });

    it("applies the reverse charge to EU businesses with a VAT id", async () => {
        const q = await quote({ country: "DE", vatId: "DE123456789" });
        expect(q).toMatchObject({ regime: "reverse_charge", rateBps: 0, amount: 0n, jurisdiction: "DE" });
        expect(q.note).toMatch(/Art\. 196/);
        expect(q.note).toMatch(/DE123456789/);
    });

    it("charges the customer country's rate to EU consumers", async () => {
        expect(await quote({ country: "RO" })).toMatchObject({ regime: "oss_destination", rateBps: 2100, amount: 21_000n });
    });

    it("treats a VAT id from another country as no VAT id", async () => {
        expect(await quote({ country: "FR", vatId: "DE123456789" })).toMatchObject({ regime: "oss_destination", rateBps: 2000 });
    });

    it("charges US sales tax only where SaaS is taxable", async () => {
        expect(await quote({ country: "US", region: "WA" })).toMatchObject({ regime: "us_sales_tax", rateBps: 650, amount: 6_500n });
        expect(await quote({ country: "US", region: "CA" })).toMatchObject({ regime: "not_taxable", amount: 0n });
    });

    it("leaves the rest of the world out of scope", async () => {
        expect(await quote({ country: "JP" })).toMatchObject({ regime: "not_taxable", amount: 0n });
    });

    it("never taxes a negative base", async () => {
        expect(await quote({ country: "IE" }, -500n)).toMatchObject({ taxable: 0n, amount: 0n });
    });

    it("rounds half up to the cent", () => {
        expect(amountFor(50n, 2300)).toBe(12n); // 11.5 -> 12
        expect(amountFor(10n, 2300)).toBe(2n); // 2.3 -> 2
        fc.assert(
            fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.integer({ min: 0, max: 3000 }), (base, bps) => {
                const exact = base * BigInt(bps); // in 1/10000 cents
                const t = amountFor(base, bps);
                expect(t * 10_000n - exact <= 5_000n && exact - t * 10_000n < 5_000n).toBe(true);
            }),
        );
    });

    it("checks VAT id prefixes", () => {
        expect(isPlausibleVatId("GR", "EL123456789")).toBe(true);
        expect(isPlausibleVatId("DE", "DE 123 456 789")).toBe(true);
        expect(isPlausibleVatId("DE", "FR12345678901")).toBe(false);
    });
});
