import { mulDivFloor } from "../money/fixed.ts";
import type { MeterPricing, Tier } from "./plan.ts";

export interface TierCharge {
    /** exclusive lower bound, micro-units */
    from: bigint;
    /** inclusive upper bound, null when unbounded */
    to: bigint | null;
    quantity: bigint;
    unitPrice: bigint;
    /** quantity x unitPrice, exact (1e-15 USD) */
    exact: bigint;
}

export interface UsageCharge {
    exact: bigint;
    tiers: TierCharge[];
}

export function priceUsage(quantity: bigint, pricing: MeterPricing): UsageCharge {
    if (quantity < 0n) throw new RangeError("negative quantity");
    return pricing.model === "tiered" ? tiered(quantity, pricing.tiers) : volume(quantity, pricing.tiers);
}

function tiered(quantity: bigint, tiers: readonly Tier[]): UsageCharge {
    const charges: TierCharge[] = [];
    let from = 0n;
    for (const tier of tiers) {
        if (quantity <= from) break;
        const top = tier.upTo === null || quantity < tier.upTo ? quantity : tier.upTo;
        const q = top - from;
        if (q > 0n) charges.push({ from, to: tier.upTo, quantity: q, unitPrice: tier.unitPrice, exact: q * tier.unitPrice });
        if (tier.upTo === null) break;
        from = tier.upTo;
    }
    return { exact: charges.reduce((acc, c) => acc + c.exact, 0n), tiers: charges };
}

function volume(quantity: bigint, tiers: readonly Tier[]): UsageCharge {
    let from = 0n;
    for (const tier of tiers) {
        if (tier.upTo === null || quantity <= tier.upTo) {
            const exact = quantity * tier.unitPrice;
            return { exact, tiers: [{ from, to: tier.upTo, quantity, unitPrice: tier.unitPrice, exact }] };
        }
        from = tier.upTo;
    }
    throw new Error("pricing has no unbounded tier");
}

/**
 * Shrinks tier boundaries to the fraction of the period a plan was active, so a
 * customer who switches plans mid-month gets each plan's allowances in
 * proportion and not twice. Boundaries are floored to whole micro-units.
 */
export function prorateTiers(pricing: MeterPricing, numerator: bigint, denominator: bigint): MeterPricing {
    if (numerator === denominator) return pricing;
    return {
        model: pricing.model,
        tiers: pricing.tiers.map((t) => ({ unitPrice: t.unitPrice, upTo: t.upTo === null ? null : mulDivFloor(t.upTo, numerator, denominator) })),
    };
}
