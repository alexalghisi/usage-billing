import type { ClientSession } from "mongodb";
import type { AuditInput, AuditLog } from "../audit/audit-log.ts";
import { METERS } from "../domain/meters.ts";
import { HOUR_MS, monthPeriod, periodKey, startOfHour, type Clock, type Period } from "../domain/time.ts";
import { canonicalJson, sha256 } from "../infra/canonical.ts";
import type { Database } from "../infra/mongo.ts";
import { inTransaction } from "../infra/tx.ts";
import type { Cents } from "../money/money.ts";
import type { Org } from "../orgs/org.ts";
import { NotFoundError, type OrgService } from "../orgs/org-service.ts";
import type { PlanCatalog } from "../rating/plan.ts";
import type { RatedSegment } from "../rating/rate.ts";
import { planSegments } from "../rating/segments.ts";
import { HOUR_CLOSE_GRACE_MS } from "../rollups/types.ts";
import type { UsageQuery } from "../rollups/usage-query.ts";
import type { TaxProvider } from "../tax/tax.ts";
import { computeCharges, periodNet, sameUsage, withTax } from "./build.ts";
import { InvalidTransitionError, type Invoice, type InvoiceContent, type PeriodAdjustment } from "./invoice.ts";

export interface InvoicingDeps {
    db: Database;
    catalog: PlanCatalog;
    tax: TaxProvider;
    clock: Clock;
    audit: AuditLog;
    orgs: OrgService;
    usage: UsageQuery;
    seller: { country: string; invoicePrefix: string };
    /** How far back late usage is still turned into adjustments. */
    adjustmentLookbackMonths?: number;
}

export type DraftOutcome = "created" | "updated" | "unchanged" | "finalized";

export class MarketplaceBilledError extends Error {
    constructor(orgId: string) {
        super(`org ${orgId} is billed through a cloud marketplace`);
        this.name = "MarketplaceBilledError";
    }
}

export class ConcurrentChangeError extends Error {
    constructor(what: string) {
        super(`concurrent change: ${what}`);
        this.name = "ConcurrentChangeError";
    }
}

export interface Estimate {
    orgId: string;
    period: string;
    asOf: Date;
    elapsedHours: number;
    totalHours: number;
    accrued: InvoiceContent;
    projectedUsage: Record<string, bigint>;
    projectedTotal: Cents;
}

function draftHashOf(content: InvoiceContent): string {
    const { usageReadAt: _ignored, ...rest } = content;
    return sha256(canonicalJson(rest));
}

/** Hash over everything a finalized invoice states; recomputing it detects any later edit. */
export function contentHashOf(invoice: InvoiceContent & { number: string; finalizedAt: Date }): string {
    const { orgId, period, periodStart, periodEnd, currency, customer, lines, subtotal, discount, credits, tax, total, amountDue, carryForward, creditApplications, usage, net, adjustments, number, finalizedAt } = invoice;
    return sha256(
        canonicalJson({ orgId, period, periodStart, periodEnd, currency, customer, lines, subtotal, discount, credits, tax, total, amountDue, carryForward, creditApplications, usage, net, adjustments, number, finalizedAt }),
    );
}

export class InvoiceService {
    private readonly d: Required<InvoicingDeps>;

    constructor(deps: InvoicingDeps) {
        this.d = { adjustmentLookbackMonths: 12, ...deps };
    }

    async get(invoiceId: string): Promise<Invoice> {
        const inv = await this.d.db.invoices.findOne({ _id: invoiceId });
        if (!inv) throw new NotFoundError(`invoice ${invoiceId}`);
        return inv;
    }

    list(orgId: string): Promise<Invoice[]> {
        return this.d.db.invoices.find({ orgId }).sort({ periodStart: -1, generatedAt: -1 }).toArray();
    }

    verify(invoice: Invoice): boolean {
        if (!invoice.number || !invoice.finalizedAt || !invoice.contentHash) return invoice.status === "draft";
        return contentHashOf({ ...invoice, number: invoice.number, finalizedAt: invoice.finalizedAt }) === invoice.contentHash;
    }

    /** Usage per plan segment, read from hourly rollups up to `until` (exclusive). */
    async segmentsWithUsage(org: Org, period: Period, until: Date = period.end): Promise<RatedSegment[]> {
        const segments = planSegments(org.plans, period);
        return Promise.all(
            segments.map(async (s) => {
                const end = s.to < until ? s.to : until > s.from ? until : s.from;
                return { ...s, usage: await this.d.usage.totals(org._id, s.from, end) };
            }),
        );
    }

    /** Earlier invoiced periods whose usage changed after they were settled. */
    async pendingAdjustments(org: Org, period: Period, key: string): Promise<PeriodAdjustment[]> {
        const settlements = await this.d.db.settlements
            .find({ orgId: org._id, period: { $lt: key } })
            .sort({ period: -1 })
            .limit(this.d.adjustmentLookbackMonths)
            .toArray();
        const out: PeriodAdjustment[] = [];
        for (const s of settlements.reverse()) {
            const p = monthPeriod(s.period);
            const touched = await this.d.db.hourlyRollups.findOne(
                { orgId: org._id, hour: { $gte: p.start, $lt: p.end }, updatedAt: { $gt: s.usageReadAt } },
                { projection: { _id: 1 } },
            );
            if (!touched) continue;
            const segments = await this.segmentsWithUsage(org, p);
            const usage = { compute: 0n, storage: 0n, transfer: 0n };
            for (const seg of segments) for (const m of METERS) usage[m] += seg.usage[m];
            if (sameUsage(usage, s.usage)) continue;
            out.push({ period: s.period, previousUsage: s.usage, usage, previousNet: s.net, net: periodNet(org, p, segments, this.d.catalog) });
        }
        return out;
    }

    async compute(org: Org, key: string, until?: Date): Promise<InvoiceContent> {
        const period = monthPeriod(key);
        const usageReadAt = this.d.clock.now();
        const [segments, adjustments, grants] = await Promise.all([
            this.segmentsWithUsage(org, period, until),
            this.pendingAdjustments(org, period, key),
            this.d.db.creditGrants.find({ orgId: org._id, remaining: { $gt: 0n } }).toArray(),
        ]);
        const charges = computeCharges({ org, periodKey: key, period, segments, adjustments, grants, catalog: this.d.catalog, usageReadAt });
        const tax = await this.d.tax.quote({ seller: this.d.seller, customer: org.taxProfile, taxable: charges.taxable, supplyDate: period.end });
        return withTax(charges, tax);
    }

    /** Creates or refreshes the draft for an org and period. Safe to call any number of times, concurrently. */
    async generateDraft(orgId: string, key: string, attempt = 0): Promise<{ invoice: Invoice; outcome: DraftOutcome }> {
        const org = await this.d.orgs.get(orgId);
        if (org.billing.channel !== "invoice") throw new MarketplaceBilledError(orgId);
        const activeKey = `${orgId}|${key}`;
        const existing = await this.d.db.invoices.findOne({ activeKey });
        if (existing && existing.status !== "draft") return { invoice: existing, outcome: "finalized" };

        const content = await this.compute(org, key);
        const draftHash = draftHashOf(content);
        const now = this.d.clock.now();
        if (existing) {
            if (existing.draftHash === draftHash) return { invoice: existing, outcome: "unchanged" };
            const updated = await this.d.db.invoices.findOneAndUpdate(
                { _id: existing._id, status: "draft" },
                { $set: { ...content, draftHash, generatedAt: now }, $inc: { draftVersion: 1 } },
                { returnDocument: "after" },
            );
            if (updated) return { invoice: updated, outcome: "updated" };
            return this.retryDraft(orgId, key, attempt);
        }
        const voided = await this.d.db.invoices.countDocuments({ orgId, period: key, status: "void" });
        const invoice: Invoice = {
            _id: `inv_${orgId}_${key}${voided > 0 ? `_r${voided}` : ""}`,
            ...content,
            status: "draft",
            activeKey,
            draftHash,
            draftVersion: 1,
            generatedAt: now,
        };
        try {
            await this.d.db.invoices.insertOne(invoice);
            return { invoice, outcome: "created" };
        } catch (error) {
            if ((error as { code?: number }).code === 11000) return this.retryDraft(orgId, key, attempt);
            throw error;
        }
    }

    private retryDraft(orgId: string, key: string, attempt: number): Promise<{ invoice: Invoice; outcome: DraftOutcome }> {
        if (attempt >= 3) throw new ConcurrentChangeError(`draft for ${orgId} ${key}`);
        return this.generateDraft(orgId, key, attempt + 1);
    }

    /**
     * draft -> finalized. Recomputes the invoice from current data, then in one
     * transaction burns the credits it uses, assigns a gapless number, freezes the
     * content under a hash, records what was settled, and writes the audit trail.
     */
    async finalize(invoiceId: string, actor: string): Promise<Invoice> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await this.finalizeOnce(invoiceId, actor);
            } catch (error) {
                if (error instanceof ConcurrentChangeError && attempt < 2) continue;
                throw error;
            }
        }
    }

    private async finalizeOnce(invoiceId: string, actor: string): Promise<Invoice> {
        const draft = await this.get(invoiceId);
        if (draft.status !== "draft") throw new InvalidTransitionError(invoiceId, draft.status, "finalized");
        const closesAt = new Date(draft.periodEnd.getTime() + HOUR_CLOSE_GRACE_MS);
        if (this.d.clock.now() < closesAt) throw new Error(`invoice ${invoiceId} cannot be finalized before ${closesAt.toISOString()}`);
        const org = await this.d.orgs.get(draft.orgId);
        const content = await this.compute(org, draft.period);

        return inTransaction(this.d.db, async (session) => {
            const db = this.d.db;
            const audit: AuditInput[] = [];
            for (const a of content.creditApplications) {
                const res = await db.creditGrants.updateOne({ _id: a.grantId, remaining: { $gte: a.amount } }, { $inc: { remaining: -a.amount } }, { session });
                if (res.modifiedCount !== 1) throw new ConcurrentChangeError(`credit grant ${a.grantId}`);
                audit.push({ actor, action: "credit.applied", entityType: "credit_grant", entityId: a.grantId, orgId: org._id, amount: -a.amount, data: { invoiceId } });
            }
            const lapsing = await db.creditGrants.find({ orgId: org._id, expiresAt: { $ne: null, $lte: draft.periodEnd }, remaining: { $gt: 0n } }, { session }).toArray();
            const lapsedCredits = lapsing.map((g) => ({ grantId: g._id, amount: g.remaining }));
            for (const g of lapsing) {
                await db.creditGrants.updateOne({ _id: g._id }, { $set: { remaining: 0n } }, { session });
                audit.push({ actor, action: "credit.expired", entityType: "credit_grant", entityId: g._id, orgId: org._id, amount: -g.remaining, data: { kind: g.kind, invoiceId } });
            }

            const year = draft.periodStart.getUTCFullYear();
            const counter = await db.counters.findOneAndUpdate({ _id: `invoice_number_${year}` }, { $inc: { value: 1 } }, { upsert: true, returnDocument: "after", session });
            const number = `${this.d.seller.invoicePrefix}-${year}-${String(counter?.value ?? 0).padStart(6, "0")}`;
            const finalizedAt = this.d.clock.now();
            const contentHash = contentHashOf({ ...content, number, finalizedAt });

            let carryForwardGrantId: string | undefined;
            if (content.carryForward > 0n) {
                const grant = await this.d.orgs.grant(session, actor, {
                    orgId: org._id,
                    kind: "balance",
                    amount: content.carryForward,
                    description: `Credit balance from invoice ${number}`,
                    effectiveAt: draft.periodEnd,
                    expiresAt: null,
                });
                carryForwardGrantId = grant._id;
            }

            const res = await db.invoices.updateOne(
                { _id: invoiceId, status: "draft" },
                {
                    $set: {
                        ...content,
                        status: "finalized",
                        number,
                        finalizedAt,
                        contentHash,
                        lapsedCredits,
                        draftHash: draftHashOf(content),
                        ...(carryForwardGrantId ? { carryForwardGrantId } : {}),
                    },
                },
                { session },
            );
            if (res.modifiedCount !== 1) throw new ConcurrentChangeError(`invoice ${invoiceId}`);

            await db.settlements.updateOne(
                { _id: `${org._id}|${content.period}` },
                { $set: { orgId: org._id, period: content.period, usage: content.usage, net: content.net, usageReadAt: content.usageReadAt }, $addToSet: { invoiceIds: invoiceId } },
                { upsert: true, session },
            );
            for (const adj of content.adjustments) {
                const r = await db.settlements.updateOne(
                    { _id: `${org._id}|${adj.period}`, net: adj.previousNet },
                    { $set: { usage: adj.usage, net: adj.net, usageReadAt: content.usageReadAt }, $addToSet: { invoiceIds: invoiceId } },
                    { session },
                );
                if (r.matchedCount !== 1) throw new ConcurrentChangeError(`settlement ${adj.period}`);
                audit.push({ actor, action: "period.adjusted", entityType: "settlement", entityId: `${org._id}|${adj.period}`, orgId: org._id, amount: adj.net - adj.previousNet, data: { invoiceId, usage: adj.usage, previousUsage: adj.previousUsage } });
            }

            audit.unshift({
                actor,
                action: "invoice.finalized",
                entityType: "invoice",
                entityId: invoiceId,
                orgId: org._id,
                amount: content.total,
                data: { number, period: content.period, subtotal: content.subtotal, discount: content.discount, credits: content.credits, tax: content.tax.amount, taxRegime: content.tax.regime, contentHash },
            });
            await this.d.audit.append(session, audit);
            const finalized = await db.invoices.findOne({ _id: invoiceId }, { session });
            if (!finalized) throw new NotFoundError(`invoice ${invoiceId}`);
            return finalized;
        });
    }

    async markPaid(invoiceId: string, actor: string, paymentReference: string): Promise<Invoice> {
        return inTransaction(this.d.db, async (session) => {
            const inv = await this.transition(session, invoiceId, "finalized", "paid", { paidAt: this.d.clock.now(), paymentReference });
            await this.d.audit.append(session, { actor, action: "invoice.paid", entityType: "invoice", entityId: invoiceId, orgId: inv.orgId, amount: -inv.amountDue, data: { paymentReference } });
            return inv;
        });
    }

    /**
     * finalized -> void. Only an org's latest finalized invoice can be voided;
     * earlier ones have been built upon (settlements, adjustments) and are
     * corrected by adjustments instead. Credits it used are given back.
     */
    async void(invoiceId: string, actor: string, reason: string): Promise<Invoice> {
        return inTransaction(this.d.db, async (session) => {
            const db = this.d.db;
            const current = await db.invoices.findOne({ _id: invoiceId }, { session });
            if (!current) throw new NotFoundError(`invoice ${invoiceId}`);
            const later = await db.invoices.findOne({ orgId: current.orgId, status: { $in: ["finalized", "paid"] }, periodStart: { $gt: current.periodStart } }, { session });
            if (later) throw new Error(`invoice ${invoiceId} has later invoices; correct it with an adjustment instead`);
            const inv = await this.transition(session, invoiceId, "finalized", "void", { voidedAt: this.d.clock.now(), voidReason: reason }, { activeKey: "" });
            const audit: AuditInput[] = [{ actor, action: "invoice.voided", entityType: "invoice", entityId: invoiceId, orgId: inv.orgId, amount: -inv.total, data: { reason, number: inv.number } }];

            const restore = [...inv.creditApplications.map((a) => ({ grantId: a.grantId, amount: a.amount })), ...(inv.lapsedCredits ?? [])];
            for (const r of restore) {
                await db.creditGrants.updateOne({ _id: r.grantId }, { $inc: { remaining: r.amount } }, { session });
                audit.push({ actor, action: "credit.restored", entityType: "credit_grant", entityId: r.grantId, orgId: inv.orgId, amount: r.amount, data: { invoiceId } });
            }
            if (inv.carryForwardGrantId) {
                const r = await db.creditGrants.updateOne({ _id: inv.carryForwardGrantId, remaining: inv.carryForward }, { $set: { remaining: 0n } }, { session });
                if (r.modifiedCount !== 1) throw new Error("the credit balance from this invoice has already been used");
                audit.push({ actor, action: "credit.revoked", entityType: "credit_grant", entityId: inv.carryForwardGrantId, orgId: inv.orgId, amount: -inv.carryForward, data: { invoiceId } });
            }
            await db.settlements.deleteOne({ _id: `${inv.orgId}|${inv.period}`, invoiceIds: [invoiceId] }, { session });
            for (const adj of inv.adjustments) {
                await db.settlements.updateOne(
                    { _id: `${inv.orgId}|${adj.period}` },
                    { $set: { usage: adj.previousUsage, net: adj.previousNet }, $pull: { invoiceIds: invoiceId } },
                    { session },
                );
                audit.push({ actor, action: "period.adjustment_reverted", entityType: "settlement", entityId: `${inv.orgId}|${adj.period}`, orgId: inv.orgId, amount: adj.previousNet - adj.net, data: { invoiceId } });
            }
            await this.d.audit.append(session, audit);
            return inv;
        });
    }

    private async transition(session: ClientSession, invoiceId: string, from: "finalized", to: "paid" | "void", set: Partial<Invoice>, unset: Record<string, ""> = {}): Promise<Invoice> {
        const updated = await this.d.db.invoices.findOneAndUpdate(
            { _id: invoiceId, status: from },
            { $set: { status: to, ...set }, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
            { returnDocument: "after", session },
        );
        if (updated) return updated;
        const inv = await this.d.db.invoices.findOne({ _id: invoiceId }, { session });
        if (!inv) throw new NotFoundError(`invoice ${invoiceId}`);
        throw new InvalidTransitionError(invoiceId, inv.status, to);
    }

    /**
     * The bill so far for the current period (usage up to the last full hour,
     * the full monthly fee, pending adjustments and credits), plus a linear
     * projection of usage to the end of the period.
     */
    async estimate(orgId: string): Promise<Estimate> {
        const org = await this.d.orgs.get(orgId);
        const now = this.d.clock.now();
        const key = periodKey(now);
        const period = monthPeriod(key);
        const until = startOfHour(now);
        const accrued = await this.compute(org, key, until);
        const elapsed = BigInt(Math.max(1, (until.getTime() - period.start.getTime()) / HOUR_MS));
        const total = BigInt((period.end.getTime() - period.start.getTime()) / HOUR_MS);
        const segments = (await this.segmentsWithUsage(org, period, until)).map((s) => ({
            ...s,
            usage: { compute: (s.usage.compute * total) / elapsed, storage: (s.usage.storage * total) / elapsed, transfer: (s.usage.transfer * total) / elapsed },
        }));
        const grants = await this.d.db.creditGrants.find({ orgId, remaining: { $gt: 0n } }).toArray();
        const charges = computeCharges({ org, periodKey: key, period, segments, adjustments: accrued.adjustments, grants, catalog: this.d.catalog, usageReadAt: now });
        const projected = withTax(charges, await this.d.tax.quote({ seller: this.d.seller, customer: org.taxProfile, taxable: charges.taxable, supplyDate: period.end }));
        const projectedUsage = { compute: 0n, storage: 0n, transfer: 0n };
        for (const s of segments) for (const m of METERS) projectedUsage[m] += s.usage[m];
        return {
            orgId,
            period: key,
            asOf: until,
            elapsedHours: Number(elapsed),
            totalHours: Number(total),
            accrued,
            projectedUsage,
            projectedTotal: projected.total,
        };
    }
}
