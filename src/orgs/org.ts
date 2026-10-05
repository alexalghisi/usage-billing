import type { Cents } from "../money/money.ts";
import type { PlanChange } from "../rating/segments.ts";

export interface TaxProfile {
    /** ISO 3166-1 alpha-2 */
    country: string;
    /** US state or similar, when the jurisdiction needs it */
    region?: string;
    /** EU VAT identification number; presence makes the customer a business for VAT */
    vatId?: string;
}

export type BillingChannel = { channel: "invoice" } | { channel: "aws_marketplace"; customerIdentifier: string; productCode: string };

export interface Contract {
    /** Committed spend for the term, prepaid and granted as credits. */
    commitment: Cents;
    /** Discount on list usage prices, basis points. */
    discountBps: number;
    startsAt: Date;
    endsAt: Date;
}

export interface Org {
    _id: string;
    name: string;
    createdAt: Date;
    billing: BillingChannel;
    taxProfile: TaxProfile;
    plans: PlanChange[];
    contract: Contract | null;
}

export function contractDiscountBps(org: Org, period: { start: Date; end: Date }): number {
    const c = org.contract;
    return c && c.startsAt < period.end && c.endsAt > period.start ? c.discountBps : 0;
}
