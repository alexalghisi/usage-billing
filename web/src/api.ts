export type Meter = "compute" | "storage" | "transfer";
export type Quantities = Record<Meter, string>;

export interface OrgSummary {
    id: string;
    name: string;
    channel: "invoice" | "aws_marketplace";
    country: string;
    planId: string;
}

export interface Grant {
    _id: string;
    kind: "trial" | "prepaid" | "balance";
    description: string;
    amount: string;
    remaining: string;
    expiresAt: string | null;
}

export interface OrgDetail {
    _id: string;
    name: string;
    billing: { channel: string; customerIdentifier?: string };
    taxProfile: { country: string; region?: string; vatId?: string };
    plans: { planId: string; effectiveFrom: string }[];
    contract: { commitment: string; discountBps: number; endsAt: string } | null;
    grants: Grant[];
}

export interface TierCharge {
    from: string;
    to: string | null;
    quantity: string;
    unitPrice: string;
}

export interface InvoiceLine {
    id: string;
    kind: "base_fee" | "usage" | "adjustment" | "discount" | "credit";
    description: string;
    amount: string;
    meter?: Meter;
    quantity?: string;
    tiers?: TierCharge[];
    source?: { from: string; to: string };
    adjustsPeriod?: string;
}

export interface TaxQuote {
    regime: string;
    jurisdiction: string;
    rateBps: number;
    amount: string;
    note: string;
}

export interface InvoiceContent {
    period: string;
    lines: InvoiceLine[];
    subtotal: string;
    discount: string;
    credits: string;
    tax: TaxQuote;
    total: string;
    amountDue: string;
    usage: Quantities;
}

export interface Invoice extends InvoiceContent {
    _id: string;
    status: "draft" | "finalized" | "paid" | "void";
    number?: string;
    periodStart: string;
    finalizedAt?: string;
    paidAt?: string;
    verified?: boolean;
}

export interface Estimate {
    period: string;
    asOf: string;
    elapsedHours: number;
    totalHours: number;
    accrued: InvoiceContent;
    projectedTotal: string;
    projectedUsage: Quantities;
}

export interface UsagePoint {
    bucket: string;
    quantities: Quantities;
}

export interface Rollup {
    hour: string;
    serviceId: string;
    quantity: string;
    recordCount: number;
    lateRecords: number;
}

export interface Drilldown {
    line: InvoiceLine;
    invoiceStatus?: "draft" | "finalized" | "paid" | "void";
    billedQuantity?: string;
    currentQuantity?: string;
    changedSinceInvoiced?: boolean;
    lateRecords?: number;
    rollups?: Rollup[];
    adjustment?: { period: string; previousUsage: Quantities; usage: Quantities; previousNet: string; net: string };
}

export interface MarketplaceReport {
    _id: string;
    dimension: string;
    hour: string;
    quantity: number;
    status: string;
    duplicate?: boolean;
    attempts: number;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(path, { signal });
    if (!res.ok) throw new Error(`${res.status} ${path}`);
    return (await res.json()) as T;
}

export const api = {
    clock: (s?: AbortSignal) => get<{ now: string; period: string }>("/api/clock", s),
    orgs: (s?: AbortSignal) => get<OrgSummary[]>("/api/orgs", s),
    org: (id: string, s?: AbortSignal) => get<OrgDetail>(`/api/orgs/${id}`, s),
    usage: (id: string, granularity: "hour" | "day", s?: AbortSignal) => get<{ points: UsagePoint[]; from: string; to: string }>(`/api/orgs/${id}/usage?granularity=${granularity}`, s),
    estimate: (id: string, s?: AbortSignal) => get<Estimate>(`/api/orgs/${id}/estimate`, s),
    invoices: (id: string, s?: AbortSignal) => get<Invoice[]>(`/api/orgs/${id}/invoices`, s),
    invoice: (id: string, s?: AbortSignal) => get<Invoice>(`/api/invoices/${id}`, s),
    drilldown: (invoiceId: string, lineId: string, s?: AbortSignal) => get<Drilldown>(`/api/invoices/${invoiceId}/lines/${encodeURIComponent(lineId)}/usage`, s),
    marketplaceReports: (id: string, s?: AbortSignal) => get<MarketplaceReport[]>(`/api/orgs/${id}/marketplace-reports`, s),
};
