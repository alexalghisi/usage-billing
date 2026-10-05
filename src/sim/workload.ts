import type { Meter } from "../domain/meters.ts";
import { addHours, DAY_MS, HOUR_MS, monthPeriod } from "../domain/time.ts";
import { randomInt, seededRandom } from "../infra/random.ts";
import type { UsageRecordInput } from "../metering/record.ts";
import { formatFixed, QTY_DECIMALS } from "../money/fixed.ts";
import type { Cents } from "../money/money.ts";
import type { TaxProfile } from "../orgs/org.ts";

export interface SimOrg {
    id: string;
    name: string;
    planId: string;
    startsAt: Date;
    upgrade?: { planId: string; at: Date };
    trial?: { amount: Cents; days: number };
    contract?: { commitment: Cents; discountBps: number; startsAt: Date; endsAt: Date };
    taxProfile: TaxProfile;
    marketplace?: { customerIdentifier: string; productCode: string };
}

/**
 * on_time: arrives during the month; late: after the month ended but before
 * invoices were finalized; after_final: after finalization (becomes an
 * adjustment); next_month: usage of the following month.
 */
export type Phase = "on_time" | "late" | "after_final" | "next_month";

export interface SimEvent {
    record: UsageRecordInput;
    phase: Phase;
    /** The producer sends this record twice. */
    duplicate: boolean;
}

export interface Workload {
    month: string;
    nextMonth: string;
    nextMonthDays: number;
    orgs: SimOrg[];
    events: SimEvent[];
}

export const PRODUCT_CODE = "prod-quarry-db";

type Profile = Omit<SimOrg, "id" | "name" | "startsAt" | "upgrade" | "trial" | "contract" | "marketplace"> & {
    upgradeTo?: string;
    midMonthSignup?: boolean;
    trial?: boolean;
    contract?: { commitment: Cents; discountBps: number };
    marketplace?: boolean;
};

// Cycled through so that even a dozen orgs cover every billing feature.
const PROFILES: Profile[] = [
    { planId: "developer", taxProfile: { country: "IE" }, trial: true },
    { planId: "scale", taxProfile: { country: "DE", vatId: "DE811569869" }, contract: { commitment: 200_000n, discountBps: 1_000 } },
    { planId: "enterprise", taxProfile: { country: "US", region: "WA" }, contract: { commitment: 5_000_000n, discountBps: 1_500 } },
    { planId: "developer", upgradeTo: "scale", taxProfile: { country: "FR" }, trial: true },
    { planId: "scale", taxProfile: { country: "US", region: "CA" } },
    { planId: "scale", taxProfile: { country: "US", region: "VA" }, marketplace: true },
    { planId: "developer", midMonthSignup: true, taxProfile: { country: "JP" }, trial: true },
    { planId: "enterprise", taxProfile: { country: "IE", vatId: "IE6388047V" } },
    { planId: "scale", taxProfile: { country: "RO" } },
    { planId: "developer", taxProfile: { country: "US", region: "OR" }, marketplace: true },
    { planId: "scale", upgradeTo: "enterprise", taxProfile: { country: "NL", vatId: "NL859048216B01" } },
    { planId: "scale", midMonthSignup: true, taxProfile: { country: "US", region: "NY" }, trial: true },
];

// Hourly usage ranges per plan, micro-units: [compute, storage, transfer].
const HOURLY: Record<string, [number, number, number]> = {
    developer: [12_000_000, 9_000_000, 80_000],
    scale: [260_000_000, 120_000_000, 2_000_000],
    enterprise: [2_400_000_000, 1_500_000_000, 20_000_000],
};

export function buildWorkload(options: { orgs: number; seed: number; month?: string; nextMonthDays?: number }): Workload {
    const random = seededRandom(options.seed);
    const month = options.month ?? "2026-09";
    const period = monthPeriod(month);
    const nextMonthDays = options.nextMonthDays ?? 3;
    const nextPeriod = monthPeriod(new Date(period.end).toISOString().slice(0, 7));
    const orgs: SimOrg[] = [];
    const events: SimEvent[] = [];

    for (let i = 0; i < options.orgs; i++) {
        const p = PROFILES[i % PROFILES.length] as Profile;
        const id = `org_${String(i + 1).padStart(4, "0")}`;
        const startsAt = p.midMonthSignup ? new Date(period.start.getTime() + randomInt(random, 1, 19) * DAY_MS + randomInt(random, 0, 23) * HOUR_MS) : period.start;
        const org: SimOrg = { id, name: `Customer ${i + 1}`, planId: p.planId, startsAt, taxProfile: p.taxProfile };
        if (p.upgradeTo) org.upgrade = { planId: p.upgradeTo, at: new Date(period.start.getTime() + randomInt(random, 10, 19) * DAY_MS) };
        if (p.trial) org.trial = { amount: 30_000n, days: 30 };
        if (p.contract) org.contract = { ...p.contract, startsAt: period.start, endsAt: new Date(Date.UTC(period.start.getUTCFullYear() + 1, period.start.getUTCMonth(), 1)) };
        if (p.marketplace) org.marketplace = { customerIdentifier: `aws-cust-${i + 1}`, productCode: PRODUCT_CODE };
        orgs.push(org);

        const scale = 0.5 + random(); // per-org size
        const end = new Date(nextPeriod.start.getTime() + nextMonthDays * DAY_MS);
        for (let hour = startsAt; hour < end; hour = addHours(hour, 1)) {
            const inNext = hour >= period.end;
            const plan = org.upgrade && hour >= org.upgrade.at ? org.upgrade.planId : org.planId;
            const [c, s, t] = HOURLY[plan] ?? [0, 0, 0];
            const emit = (meter: Meter, service: string, max: number, minute: number) => {
                const micro = randomInt(random, 0, Math.floor(max * scale));
                const r = random();
                events.push({
                    record: {
                        eventId: `${hour.toISOString()}:${meter}:${service}`,
                        orgId: id,
                        serviceId: `${id}_${service}`,
                        meter,
                        quantity: formatFixed(BigInt(micro), QTY_DECIMALS),
                        timestamp: new Date(hour.getTime() + minute * 60_000).toISOString(),
                    },
                    phase: inNext ? "next_month" : r < 0.005 ? "after_final" : r < 0.015 ? "late" : "on_time",
                    duplicate: random() < 0.03,
                });
            };
            for (const service of ["primary", "replica"]) {
                emit("compute", service, c / 2, randomInt(random, 0, 59));
                emit("storage", service, s / 2, 59);
            }
            if (random() < 0.3) emit("transfer", "primary", t * 3, randomInt(random, 0, 59));
        }
    }
    return { month, nextMonth: nextPeriod.start.toISOString().slice(0, 7), nextMonthDays, orgs, events };
}
