import { METERS, type Meter } from "../domain/meters.ts";
import { parseFixed, PRICE_DECIMALS, QTY_DECIMALS } from "../money/fixed.ts";
import { cents, type Cents } from "../money/money.ts";

export interface Tier {
    /** Cumulative upper bound in micro-units, inclusive; null for the last tier. */
    upTo: bigint | null;
    /** nano-USD per meter unit */
    unitPrice: bigint;
}

/**
 * tiered: each unit is charged at the price of the tier it falls into (graduated).
 * volume: every unit is charged at the price of the tier the total falls into.
 */
export interface MeterPricing {
    model: "tiered" | "volume";
    tiers: Tier[];
}

export interface PricePlan {
    id: string;
    name: string;
    /** Flat monthly fee, prorated by time when the plan is active for part of a period. */
    baseFee: Cents;
    meters: Record<Meter, MeterPricing>;
}

export interface PlanSpec {
    id: string;
    name: string;
    baseFee: string;
    meters: Record<Meter, { model: MeterPricing["model"]; tiers: [upTo: string | null, unitPrice: string][] }>;
}

export function definePlan(spec: PlanSpec): PricePlan {
    const meters = {} as Record<Meter, MeterPricing>;
    for (const meter of METERS) {
        const m = spec.meters[meter];
        const tiers = m.tiers.map(([upTo, price]) => ({
            upTo: upTo === null ? null : parseFixed(upTo, QTY_DECIMALS),
            unitPrice: parseFixed(price, PRICE_DECIMALS),
        }));
        validateTiers(spec.id, meter, tiers);
        meters[meter] = { model: m.model, tiers };
    }
    return { id: spec.id, name: spec.name, baseFee: cents(spec.baseFee), meters };
}

function validateTiers(planId: string, meter: Meter, tiers: Tier[]): void {
    if (tiers.length === 0) throw new Error(`${planId}/${meter}: no tiers`);
    let previous = 0n;
    tiers.forEach((t, i) => {
        const last = i === tiers.length - 1;
        if (t.unitPrice < 0n) throw new Error(`${planId}/${meter}: negative price`);
        if (last !== (t.upTo === null)) throw new Error(`${planId}/${meter}: only the last tier may be unbounded`);
        if (t.upTo !== null) {
            if (t.upTo <= previous) throw new Error(`${planId}/${meter}: tier bounds must increase`);
            previous = t.upTo;
        }
    });
}

export class PlanCatalog {
    private readonly plans: Map<string, PricePlan>;
    constructor(plans: readonly PricePlan[]) {
        this.plans = new Map(plans.map((p) => [p.id, p]));
    }
    get(id: string): PricePlan {
        const plan = this.plans.get(id);
        if (!plan) throw new Error(`unknown plan: ${id}`);
        return plan;
    }
    all(): PricePlan[] {
        return [...this.plans.values()];
    }
}
