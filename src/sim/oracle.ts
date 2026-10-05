import { Decimal } from "decimal.js";
import { METERS, type Meter } from "../domain/meters.ts";
import { DAY_MS, monthPeriod, type Period } from "../domain/time.ts";
import type { MeterPricing, PlanCatalog } from "../rating/plan.ts";
import type { Phase, SimEvent, SimOrg, Workload } from "./workload.ts";

// An independent reference calculation for the month simulation. It works from
// the generated events directly (no SQS, no MongoDB, no rollups) and uses
// decimal.js instead of the production bigint code, following the written
// billing rules: tiers, proration, per-line half-even rounding, discount,
// credit order and expiry, and half-up tax.

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_EVEN });
type Dec = InstanceType<typeof D>;

export interface ExpectedInvoice {
    subtotal: bigint;
    discount: bigint;
    credits: bigint;
    tax: bigint;
    total: bigint;
}

export interface Expectations {
    invoices: Map<string, { month: ExpectedInvoice; next: ExpectedInvoice }>;
    /** "<customerIdentifier>|<meter>" -> whole units */
    marketplaceUnits: Map<string, bigint>;
}

const VAT_BPS: Record<string, number> = { IE: 2300, DE: 1900, FR: 2000, RO: 2100, NL: 2100 };
const US_BPS: Record<string, number> = { WA: 650, NY: 400 };

function toCents(d: Dec, rounding: Decimal.Rounding = D.ROUND_HALF_EVEN): bigint {
    return BigInt(d.toDecimalPlaces(0, rounding).toFixed(0));
}

function taxBps(org: SimOrg): number {
    const { country, vatId, region } = org.taxProfile;
    if (country === "IE") return VAT_BPS.IE ?? 0;
    if (country in VAT_BPS) return vatId ? 0 : (VAT_BPS[country] ?? 0);
    if (country === "US") return US_BPS[region ?? ""] ?? 0;
    return 0;
}

function segments(org: SimOrg, period: Period): { planId: string; from: Date; to: Date }[] {
    const from = org.startsAt > period.start ? org.startsAt : period.start;
    if (from >= period.end) return [];
    const change = org.upgrade?.at;
    if (!change || change >= period.end) return [{ planId: org.planId, from, to: period.end }];
    if (change <= from) return [{ planId: org.upgrade?.planId ?? org.planId, from, to: period.end }];
    return [
        { planId: org.planId, from, to: change },
        { planId: org.upgrade?.planId ?? org.planId, from: change, to: period.end },
    ];
}

function priceDollars(quantity: Dec, pricing: MeterPricing, segmentMs: Dec, periodMs: Dec): Dec {
    // Multiply before dividing so a bound that scales to a whole micro-unit stays whole.
    const bound = (upTo: bigint) => new D(upTo.toString()).mul(segmentMs).div(periodMs).floor().div(1e6);
    const price = (p: bigint) => new D(p.toString()).div(1e9);
    if (pricing.model === "volume") {
        for (const t of pricing.tiers) if (t.upTo === null || quantity.lte(bound(t.upTo))) return quantity.mul(price(t.unitPrice));
        return new D(0);
    }
    let total = new D(0);
    let lower = new D(0);
    for (const t of pricing.tiers) {
        const upper = t.upTo === null ? quantity : D.min(quantity, bound(t.upTo));
        if (upper.gt(lower)) total = total.add(upper.sub(lower).mul(price(t.unitPrice)));
        if (t.upTo === null || quantity.lte(upper)) break;
        lower = upper;
    }
    return total;
}

function usage(events: readonly SimEvent[], phases: readonly Phase[], from: Date, to: Date): Record<Meter, Dec> {
    const out = { compute: new D(0), storage: new D(0), transfer: new D(0) };
    for (const e of events) {
        if (!phases.includes(e.phase)) continue;
        const t = new Date(e.record.timestamp);
        if (t >= from && t < to) out[e.record.meter] = out[e.record.meter].add(e.record.quantity);
    }
    return out;
}

/** Fees and usage for a period minus the contract discount, in cents. */
function net(org: SimOrg, period: Period, events: readonly SimEvent[], phases: readonly Phase[], catalog: PlanCatalog): bigint {
    const periodMs = new D(period.end.getTime() - period.start.getTime());
    let fees = 0n;
    let usageCents = 0n;
    for (const seg of segments(org, period)) {
        const plan = catalog.get(seg.planId);
        const fee = new D(plan.baseFee.toString());
        const cum = (t: Date) => toCents(fee.mul(t.getTime() - period.start.getTime()).div(periodMs));
        fees += cum(seg.to) - cum(seg.from);
        const segmentMs = new D(seg.to.getTime() - seg.from.getTime());
        const used = usage(events, phases, seg.from, seg.to);
        for (const m of METERS) usageCents += toCents(priceDollars(used[m], plan.meters[m], segmentMs, periodMs).mul(100));
    }
    const c = org.contract;
    const bps = c && c.startsAt < period.end && c.endsAt > period.start ? c.discountBps : 0;
    return fees + usageCents - toCents(new D(usageCents.toString()).mul(bps).div(10_000));
}

interface Grant {
    kind: number;
    remaining: bigint;
    effectiveAt: Date;
    expiresAt: Date;
}

function invoice(org: SimOrg, period: Period, ownNet: bigint, adjustment: bigint, discount: bigint, grants: Grant[]): ExpectedInvoice {
    const subtotal = ownNet + discount + adjustment;
    let due = subtotal - discount;
    let credits = 0n;
    const usable = grants
        .filter((g) => g.remaining > 0n && g.effectiveAt < period.end && g.expiresAt > period.start)
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime() || a.kind - b.kind);
    for (const g of usable) {
        if (due <= 0n) break;
        const take = g.remaining < due ? g.remaining : due;
        g.remaining -= take;
        due -= take;
        credits += take;
    }
    for (const g of grants) if (g.expiresAt <= period.end) g.remaining = 0n;
    const taxable = subtotal - discount - credits;
    const tax = taxable > 0n ? toCents(new D(taxable.toString()).mul(taxBps(org)).div(10_000), D.ROUND_HALF_UP) : 0n;
    return { subtotal, discount, credits, tax, total: taxable + tax };
}

function discountOf(org: SimOrg, period: Period, events: readonly SimEvent[], phases: readonly Phase[], catalog: PlanCatalog): bigint {
    const c = org.contract;
    if (!c || !(c.startsAt < period.end && c.endsAt > period.start)) return 0n;
    const withoutDiscount = { ...org, contract: undefined } as SimOrg;
    const gross = net(withoutDiscount, period, events, phases, catalog);
    return gross - net(org, period, events, phases, catalog);
}

export function expectedOutcome(workload: Workload, catalog: PlanCatalog): Expectations {
    const month = monthPeriod(workload.month);
    const next = monthPeriod(workload.nextMonth);
    const invoices = new Map<string, { month: ExpectedInvoice; next: ExpectedInvoice }>();
    const marketplaceUnits = new Map<string, bigint>();
    const byOrg = new Map<string, SimEvent[]>();
    for (const e of workload.events) byOrg.set(e.record.orgId, [...(byOrg.get(e.record.orgId) ?? []), e]);

    for (const org of workload.orgs) {
        const events = byOrg.get(org.id) ?? [];
        if (org.marketplace) {
            const all = usage(events, ["on_time", "late", "after_final", "next_month"], new Date(0), new Date(8.64e15));
            for (const m of METERS) marketplaceUnits.set(`${org.marketplace.customerIdentifier}|${m}`, BigInt(all[m].floor().toFixed(0)));
            continue;
        }
        const grants: Grant[] = [];
        if (org.trial) grants.push({ kind: 0, remaining: org.trial.amount, effectiveAt: org.startsAt, expiresAt: new Date(org.startsAt.getTime() + org.trial.days * DAY_MS) });
        if (org.contract) grants.push({ kind: 1, remaining: org.contract.commitment, effectiveAt: org.contract.startsAt, expiresAt: org.contract.endsAt });

        const billed: Phase[] = ["on_time", "late"];
        const everything: Phase[] = ["on_time", "late", "after_final"];
        const first = invoice(org, month, net(org, month, events, billed, catalog), 0n, discountOf(org, month, events, billed, catalog), grants);
        const adjustment = net(org, month, events, everything, catalog) - net(org, month, events, billed, catalog);
        const nextPhases: Phase[] = ["next_month"];
        const second = invoice(org, next, net(org, next, events, nextPhases, catalog), adjustment, discountOf(org, next, events, nextPhases, catalog), grants);
        invoices.set(org.id, { month: first, next: second });
    }
    return { invoices, marketplaceUnits };
}
