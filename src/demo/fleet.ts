import type { Meter } from "../domain/meters.ts";
import { HOUR_MS } from "../domain/time.ts";
import type { UsageRecordInput } from "../metering/record.ts";
import { formatFixed, QTY_DECIMALS } from "../money/fixed.ts";
import type { BillingChannel, TaxProfile } from "../orgs/org.ts";

export interface DemoOrg {
    id: string;
    name: string;
    planId: string;
    upgrade?: { planId: string; at: string };
    taxProfile: TaxProfile;
    billing: BillingChannel;
    contract?: { commitment: bigint; discountBps: number };
    trialFrom?: string;
    startsAt?: string;
    /** Usage per hour in micro-units at the daily average. */
    hourly: Record<Meter, bigint>;
}

export const DEMO_ORGS: DemoOrg[] = [
    {
        id: "org_acme",
        name: "Acme Analytics",
        planId: "scale",
        taxProfile: { country: "IE" },
        billing: { channel: "invoice" },
        hourly: { compute: 210_000_000n, storage: 95_000_000n, transfer: 1_400_000n },
    },
    {
        id: "org_globex",
        name: "Globex Logistics",
        planId: "enterprise",
        taxProfile: { country: "DE", vatId: "DE811569869" },
        billing: { channel: "invoice" },
        contract: { commitment: 6_000_000n, discountBps: 1_200 },
        hourly: { compute: 1_900_000_000n, storage: 1_100_000_000n, transfer: 16_000_000n },
    },
    {
        id: "org_initech",
        name: "Initech",
        planId: "developer",
        upgrade: { planId: "scale", at: "2026-09-10T00:00:00Z" },
        taxProfile: { country: "FR" },
        billing: { channel: "invoice" },
        hourly: { compute: 60_000_000n, storage: 20_000_000n, transfer: 300_000n },
    },
    {
        id: "org_hooli",
        name: "Hooli Search",
        planId: "scale",
        taxProfile: { country: "US", region: "CA" },
        billing: { channel: "aws_marketplace", customerIdentifier: "aws-cust-hooli", productCode: "prod-quarry-db" },
        hourly: { compute: 340_000_000n, storage: 140_000_000n, transfer: 2_500_000n },
    },
    {
        id: "org_stark",
        name: "Stark Labs",
        planId: "developer",
        startsAt: "2026-09-01T00:00:00Z",
        trialFrom: "2026-09-01T00:00:00Z",
        taxProfile: { country: "US", region: "WA" },
        billing: { channel: "invoice" },
        hourly: { compute: 14_000_000n, storage: 8_000_000n, transfer: 90_000n },
    },
];

// Load over the day, in permille of the average: quiet at night (UTC), busy in the afternoon.
const DIURNAL = [520, 450, 400, 380, 400, 480, 620, 820, 1050, 1250, 1380, 1450, 1500, 1520, 1480, 1400, 1300, 1180, 1050, 920, 820, 720, 640, 580];

function hash(text: string): number {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    return (h >>> 0) / 4294967296;
}

/**
 * Usage an org's two services emit for [from, to). Deterministic: the same
 * interval always produces the same records with the same event ids, so
 * re-emitting it is harmless.
 */
export function emitUsage(org: DemoOrg, from: Date, to: Date): UsageRecordInput[] {
    const out: UsageRecordInput[] = [];
    const ms = BigInt(to.getTime() - from.getTime());
    if (ms <= 0n) return out;
    const hour = from.getUTCHours();
    const day = Math.floor(from.getTime() / 86_400_000);
    for (const service of ["primary", "replica"]) {
        for (const meter of ["compute", "storage", "transfer"] as Meter[]) {
            const jitter = BigInt(Math.floor(700 + 600 * hash(`${org.id}${service}${meter}${from.getTime()}`)));
            const daily = BigInt(Math.floor(850 + 300 * hash(`${org.id}${day}`)));
            const shape = meter === "storage" ? 1000n : BigInt(DIURNAL[hour] ?? 1000);
            const micro = (org.hourly[meter] / 2n) * shape * jitter * daily * ms / (1000n * 1000n * 1000n * BigInt(HOUR_MS));
            if (micro === 0n && meter === "transfer") continue;
            out.push({
                eventId: `${from.toISOString()}/${to.getTime() - from.getTime()}`,
                orgId: org.id,
                serviceId: `${org.id.replace("org_", "")}-${service}`,
                meter,
                quantity: formatFixed(micro, QTY_DECIMALS),
                timestamp: from.toISOString(),
            });
        }
    }
    return out;
}
