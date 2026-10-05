import { METERS, METER_UNITS, type Meter, type MeterQuantities } from "../domain/meters.ts";
import type { Period } from "../domain/time.ts";
import { divRound, formatFixed, QTY_DECIMALS } from "../money/fixed.ts";
import { exactToCents, type Cents } from "../money/money.ts";
import type { PlanCatalog } from "./plan.ts";
import { priceUsage, prorateTiers, type TierCharge } from "./price.ts";
import type { Segment } from "./segments.ts";

export interface RatedSegment extends Segment {
    usage: MeterQuantities;
}

export interface RatedLine {
    id: string;
    kind: "base_fee" | "usage";
    planId: string;
    meter?: Meter;
    from: Date;
    to: Date;
    quantity?: bigint;
    tiers?: TierCharge[];
    amount: Cents;
    description: string;
}

/**
 * Base fee for [from, to) inside the period. Rounded on cumulative positions
 * (fee up to `to` minus fee up to `from`), so any split of the period under one
 * plan adds up to exactly the monthly fee.
 */
export function prorateFee(fee: Cents, from: Date, to: Date, period: Period): Cents {
    const total = BigInt(period.end.getTime() - period.start.getTime());
    const upTo = (d: Date) => divRound(fee * BigInt(d.getTime() - period.start.getTime()), total, "half-even");
    return upTo(to) - upTo(from);
}

function isoDay(d: Date): string {
    return d.toISOString().slice(0, 10);
}

/**
 * Rates usage per plan segment. Usage lines are rounded to cents once, half to
 * even, after the exact tier arithmetic; nothing upstream of that is rounded.
 */
export function rateSegments(period: Period, segments: readonly RatedSegment[], catalog: PlanCatalog): RatedLine[] {
    const lines: RatedLine[] = [];
    const periodMs = BigInt(period.end.getTime() - period.start.getTime());
    const partial = segments.length > 1 || segments.some((s) => s.from > period.start || s.to < period.end);
    segments.forEach((segment, index) => {
        const plan = catalog.get(segment.planId);
        const segmentMs = BigInt(segment.to.getTime() - segment.from.getTime());
        const suffix = partial ? ` (${isoDay(segment.from)} to ${isoDay(new Date(segment.to.getTime() - 1))})` : "";
        if (plan.baseFee > 0n) {
            lines.push({
                id: `base:${index}`,
                kind: "base_fee",
                planId: plan.id,
                from: segment.from,
                to: segment.to,
                amount: prorateFee(plan.baseFee, segment.from, segment.to, period),
                description: `${plan.name} plan${suffix}`,
            });
        }
        for (const meter of METERS) {
            const quantity = segment.usage[meter];
            const pricing = prorateTiers(plan.meters[meter], segmentMs, periodMs);
            const charge = priceUsage(quantity, pricing);
            lines.push({
                id: `usage:${meter}:${index}`,
                kind: "usage",
                planId: plan.id,
                meter,
                from: segment.from,
                to: segment.to,
                quantity,
                tiers: charge.tiers,
                amount: exactToCents(charge.exact, "half-even"),
                description: `${meter[0]?.toUpperCase()}${meter.slice(1)}: ${formatFixed(quantity, QTY_DECIMALS)} ${METER_UNITS[meter]}${suffix}`,
            });
        }
    });
    return lines;
}

/** Applies a contract discount (basis points) to the usage lines' total. */
export function discountFor(lines: readonly RatedLine[], discountBps: number): Cents {
    if (discountBps <= 0) return 0n;
    const usage = lines.filter((l) => l.kind === "usage").reduce((acc, l) => acc + l.amount, 0n);
    return divRound(usage * BigInt(discountBps), 10_000n, "half-even");
}
