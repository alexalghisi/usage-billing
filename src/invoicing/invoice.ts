import type { Meter, MeterQuantities } from "../domain/meters.ts";
import type { Cents } from "../money/money.ts";
import type { TaxProfile } from "../orgs/org.ts";
import type { CreditApplication } from "../rating/credits.ts";
import type { TierCharge } from "../rating/price.ts";
import type { TaxQuote } from "../tax/tax.ts";

export type InvoiceStatus = "draft" | "finalized" | "paid" | "void";

export interface InvoiceLine {
    id: string;
    kind: "base_fee" | "usage" | "adjustment" | "discount" | "credit";
    description: string;
    amount: Cents;
    planId?: string;
    meter?: Meter;
    quantity?: bigint;
    tiers?: TierCharge[];
    /** The rollups this line was computed from: hourly rollups of `meter` for `orgId` in [from, to). */
    source?: { orgId: string; meter: Meter; from: Date; to: Date };
    adjustsPeriod?: string;
    grantId?: string;
}

/** Re-rating of an earlier, already invoiced period whose usage changed after it was invoiced. */
export interface PeriodAdjustment {
    period: string;
    previousUsage: MeterQuantities;
    usage: MeterQuantities;
    previousNet: Cents;
    net: Cents;
}

export interface InvoiceContent {
    orgId: string;
    period: string;
    periodStart: Date;
    periodEnd: Date;
    currency: "USD";
    customer: { name: string; taxProfile: TaxProfile };
    lines: InvoiceLine[];
    /** base fees + usage + adjustments */
    subtotal: Cents;
    discount: Cents;
    /** credits applied, as a positive number */
    credits: Cents;
    tax: TaxQuote;
    /** subtotal - discount - credits + tax; negative only when adjustments exceed the charges */
    total: Cents;
    /** max(total, 0) */
    amountDue: Cents;
    /** Credit owed to the customer when adjustments push the total below zero. */
    carryForward: Cents;
    creditApplications: CreditApplication[];
    /** Usage billed for this period, per meter. */
    usage: MeterQuantities;
    /** Net charge for this period's own usage and fees (before credits and tax). */
    net: Cents;
    adjustments: PeriodAdjustment[];
    /** When usage was read; rollups changed after this are not reflected. */
    usageReadAt: Date;
}

export interface Invoice extends InvoiceContent {
    _id: string;
    status: InvoiceStatus;
    /** "<orgId>|<period>" while the invoice is not void; unique, so an org has one live invoice per period. */
    activeKey?: string;
    number?: string;
    draftHash: string;
    draftVersion: number;
    contentHash?: string;
    generatedAt: Date;
    finalizedAt?: Date;
    paidAt?: Date;
    paymentReference?: string;
    voidedAt?: Date;
    voidReason?: string;
    /** Unused credit that expired with this invoice's period and was written off when it was finalized. */
    lapsedCredits?: { grantId: string; amount: Cents }[];
    /** Credit grant created for carryForward. */
    carryForwardGrantId?: string;
}

export interface Settlement {
    /** "<orgId>|<period>" */
    _id: string;
    orgId: string;
    period: string;
    usage: MeterQuantities;
    net: Cents;
    usageReadAt: Date;
    invoiceIds: string[];
}

export class InvalidTransitionError extends Error {
    constructor(invoiceId: string, from: string, to: InvoiceStatus) {
        super(`invoice ${invoiceId} cannot go from ${from} to ${to}`);
        this.name = "InvalidTransitionError";
    }
}

const TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
    draft: ["finalized"],
    finalized: ["paid", "void"],
    paid: [],
    void: [],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
    return TRANSITIONS[from].includes(to);
}
