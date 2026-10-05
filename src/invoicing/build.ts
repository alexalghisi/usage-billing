import { formatQuantity, METERS, METER_UNITS, zeroQuantities, type MeterQuantities } from "../domain/meters.ts";
import type { Period } from "../domain/time.ts";
import { formatFixed } from "../money/fixed.ts";
import type { Cents } from "../money/money.ts";
import { contractDiscountBps, type Org } from "../orgs/org.ts";
import { applyCredits, type CreditGrant } from "../rating/credits.ts";
import type { PlanCatalog } from "../rating/plan.ts";
import { discountFor, rateSegments, type RatedSegment } from "../rating/rate.ts";
import type { TaxQuote } from "../tax/tax.ts";
import type { InvoiceContent, InvoiceLine, PeriodAdjustment } from "./invoice.ts";

export interface ChargeInput {
    org: Org;
    periodKey: string;
    period: Period;
    segments: readonly RatedSegment[];
    adjustments: readonly PeriodAdjustment[];
    grants: readonly CreditGrant[];
    catalog: PlanCatalog;
    usageReadAt: Date;
}

export type Charges = Omit<InvoiceContent, "tax" | "total" | "amountDue" | "carryForward"> & { taxable: Cents };

/** Net charge for one period's own fees and usage: rated lines minus the contract discount. */
export function periodNet(org: Org, period: Period, segments: readonly RatedSegment[], catalog: PlanCatalog): Cents {
    const lines = rateSegments(period, segments, catalog);
    return lines.reduce((acc, l) => acc + l.amount, 0n) - discountFor(lines, contractDiscountBps(org, period));
}

function describeDelta(adj: PeriodAdjustment): string {
    const parts = METERS.filter((m) => adj.usage[m] !== adj.previousUsage[m]).map((m) => {
        const delta = adj.usage[m] - adj.previousUsage[m];
        return `${m} ${delta > 0n ? "+" : ""}${formatQuantity(delta)} ${METER_UNITS[m]}`;
    });
    return `Adjustment for ${adj.period}: usage reported after invoicing (${parts.join(", ")})`;
}

/** Everything up to and including credits. Pure: same input, same invoice. */
export function computeCharges(input: ChargeInput): Charges {
    const { org, period, catalog } = input;
    const rated = rateSegments(period, input.segments, catalog);
    const lines: InvoiceLine[] = rated.map((l) => ({
        id: l.id,
        kind: l.kind,
        description: l.description,
        amount: l.amount,
        planId: l.planId,
        ...(l.meter ? { meter: l.meter, quantity: l.quantity, tiers: l.tiers, source: { orgId: org._id, meter: l.meter, from: l.from, to: l.to } } : {}),
    }));
    const discount = discountFor(rated, contractDiscountBps(org, period));
    const ownCharges = rated.reduce((acc, l) => acc + l.amount, 0n);

    for (const adj of input.adjustments) {
        const amount = adj.net - adj.previousNet;
        if (amount !== 0n) lines.push({ id: `adjustment:${adj.period}`, kind: "adjustment", description: describeDelta(adj), amount, adjustsPeriod: adj.period });
    }
    const subtotal = lines.reduce((acc, l) => acc + l.amount, 0n);
    if (discount > 0n) {
        lines.push({ id: "discount", kind: "discount", description: `Contract discount (${formatFixed(BigInt(contractDiscountBps(org, period)), 2)}% of usage)`, amount: -discount });
    }

    const { applied } = applyCredits(subtotal - discount, input.grants, period);
    for (const a of applied) lines.push({ id: `credit:${a.grantId}`, kind: "credit", description: a.description, amount: -a.amount, grantId: a.grantId });
    const credits = applied.reduce((acc, a) => acc + a.amount, 0n);

    const usage = zeroQuantities();
    for (const s of input.segments) for (const m of METERS) usage[m] += s.usage[m];

    return {
        orgId: org._id,
        period: input.periodKey,
        periodStart: period.start,
        periodEnd: period.end,
        currency: "USD",
        customer: { name: org.name, taxProfile: org.taxProfile },
        lines,
        subtotal,
        discount,
        credits,
        creditApplications: applied,
        taxable: subtotal - discount - credits,
        usage,
        net: ownCharges - discount,
        adjustments: [...input.adjustments],
        usageReadAt: input.usageReadAt,
    };
}

export function withTax(charges: Charges, tax: TaxQuote): InvoiceContent {
    const { taxable, ...rest } = charges;
    const total = taxable + tax.amount;
    return { ...rest, tax, total, amountDue: total > 0n ? total : 0n, carryForward: total < 0n ? -total : 0n };
}

export function sameUsage(a: MeterQuantities, b: MeterQuantities): boolean {
    return METERS.every((m) => a[m] === b[m]);
}
