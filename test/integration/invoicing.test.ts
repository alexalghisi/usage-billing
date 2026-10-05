import { afterEach, describe, expect, it } from "vitest";
import { createServices, type Services } from "../../src/app/context.ts";
import { FixedClock, monthPeriod } from "../../src/domain/time.ts";
import { InvalidTransitionError } from "../../src/invoicing/invoice.ts";
import { MarketplaceBilledError } from "../../src/invoicing/invoice-service.ts";
import { runInvoices } from "../../src/invoicing/invoice-run.ts";
import type { Database } from "../../src/infra/mongo.ts";
import { parseFixed } from "../../src/money/fixed.ts";
import { exactToCents } from "../../src/money/money.ts";
import { scale } from "../../src/rating/catalog.ts";
import { priceUsage } from "../../src/rating/price.ts";
import { testDatabase } from "../helpers/env.ts";
import { ingest, usage } from "../helpers/records.ts";

const open: Database[] = [];
afterEach(async () => {
    for (const db of open.splice(0)) {
        await db.drop();
        await db.client.close();
    }
});

async function setup(): Promise<Services & { clock: FixedClock }> {
    const db = await testDatabase("invoicing");
    open.push(db);
    const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
    return { ...createServices(db, clock), clock };
}

async function createOrg(s: Services, id: string, extra: { country?: string; vatId?: string; trial?: bigint; planId?: string } = {}) {
    return s.orgs.create({
        _id: id,
        name: `Org ${id}`,
        billing: { channel: "invoice" },
        taxProfile: { country: extra.country ?? "IE", ...(extra.vatId ? { vatId: extra.vatId } : {}) },
        planId: extra.planId ?? "scale",
        ...(extra.trial ? { trialCredit: { amount: extra.trial, days: 30 } } : {}),
    });
}

/** Records compute usage at the given ISO timestamps, as if they arrived at the clock's current time. */
async function compute(s: Services & { clock: FixedClock }, orgId: string, amount: string, at: string) {
    const arrival = s.clock.now();
    s.clock.set(new Date(Math.max(arrival.getTime(), new Date(at).getTime())));
    const record = usage(orgId, "compute", amount, at, s.clock);
    s.clock.set(arrival);
    await ingest(s.db, [record]);
    await s.aggregator.drain();
}

const afterAugust = new Date("2026-09-01T03:00:00Z");

describe("invoice lifecycle", () => {
    it("keeps one draft per org and period and refreshes it when usage changes", async () => {
        const s = await setup();
        await createOrg(s, "org_a");
        await compute(s, "org_a", "1000", "2026-08-03T10:00:00Z");
        const first = await s.invoices.generateDraft("org_a", "2026-08");
        expect(first.outcome).toBe("created");
        expect(first.invoice._id).toBe("inv_org_a_2026-08");
        expect((await s.invoices.generateDraft("org_a", "2026-08")).outcome).toBe("unchanged");

        await compute(s, "org_a", "500", "2026-08-03T11:00:00Z");
        const refreshed = await s.invoices.generateDraft("org_a", "2026-08");
        expect(refreshed.outcome).toBe("updated");
        expect(refreshed.invoice.draftVersion).toBe(2);
        expect(refreshed.invoice.usage.compute).toBe(parseFixed("1500", 6));
        expect(await s.db.invoices.countDocuments()).toBe(1);
    });

    it("finalizes once: burns credits, numbers the invoice, freezes it and audits it", async () => {
        const s = await setup();
        await createOrg(s, "org_a", { trial: 5_000n });
        await compute(s, "org_a", "1000", "2026-08-03T10:00:00Z");
        const { invoice: draft } = await s.invoices.generateDraft("org_a", "2026-08");

        s.clock.set(new Date("2026-09-01T00:30:00Z"));
        await expect(s.invoices.finalize(draft._id, "test")).rejects.toThrow(/cannot be finalized before/);

        s.clock.set(afterAugust);
        const inv = await s.invoices.finalize(draft._id, "test");
        // $99 + 1,000 x $0.0036 = $102.60, minus the $50 trial, plus 23% VAT on $52.60
        expect(inv).toMatchObject({ status: "finalized", number: "QC-2026-000001", subtotal: 10_260n, credits: 5_000n, total: 5_260n + 1_210n });
        expect(s.invoices.verify(inv)).toBe(true);
        expect((await s.orgs.grants("org_a"))[0]?.remaining).toBe(0n);

        expect((await s.invoices.generateDraft("org_a", "2026-08")).outcome).toBe("finalized");
        await expect(s.invoices.finalize(draft._id, "test")).rejects.toBeInstanceOf(InvalidTransitionError);

        const actions = (await s.audit.list({ orgId: "org_a" })).map((e) => e.action).reverse();
        expect(actions).toEqual(["org.created", "credit.granted", "invoice.finalized", "credit.applied"]);
        expect(await s.audit.verify()).toEqual({ ok: true, entries: 4 });

        await s.db.invoices.updateOne({ _id: inv._id }, { $set: { total: 1n } });
        expect(s.invoices.verify(await s.invoices.get(inv._id))).toBe(false);
    });

    it("turns usage that arrives after finalization into an adjustment on the next invoice", async () => {
        const s = await setup();
        await createOrg(s, "org_a", { country: "DE", vatId: "DE123456789" });
        await compute(s, "org_a", "99000", "2026-08-10T10:00:00Z");
        s.clock.set(afterAugust);
        const aug = await s.invoices.finalize((await s.invoices.generateDraft("org_a", "2026-08")).invoice._id, "test");
        expect(aug.tax).toMatchObject({ regime: "reverse_charge", amount: 0n });

        // 2,000 late unit-minutes for August cross Scale's first price band.
        s.clock.set(new Date("2026-09-05T00:00:00Z"));
        await compute(s, "org_a", "2000", "2026-08-31T23:00:00Z");
        await compute(s, "org_a", "10", "2026-09-02T00:00:00Z");
        const priceOf = (q: string) => exactToCents(priceUsage(parseFixed(q, 6), scale.meters.compute).exact);
        const expectedDelta = priceOf("101000") - priceOf("99000");

        s.clock.set(new Date("2026-10-01T03:00:00Z"));
        const sep = await s.invoices.finalize((await s.invoices.generateDraft("org_a", "2026-09")).invoice._id, "test");
        const adj = sep.lines.find((l) => l.kind === "adjustment");
        expect(adj).toMatchObject({ adjustsPeriod: "2026-08", amount: expectedDelta });
        expect(sep.subtotal).toBe(9_900n + priceOf("10") + expectedDelta);
        expect(await s.db.settlements.findOne({ _id: "org_a|2026-08" })).toMatchObject({ usage: { compute: parseFixed("101000", 6) }, invoiceIds: [aug._id, sep._id] });

        // Once settled, the same late usage is never billed twice.
        const oct = await s.invoices.generateDraft("org_a", "2026-10");
        expect(oct.invoice.lines.some((l) => l.kind === "adjustment")).toBe(false);
    });

    it("voids only the latest invoice and gives back what it took", async () => {
        const s = await setup();
        await createOrg(s, "org_a", { trial: 50_000n });
        await compute(s, "org_a", "1000", "2026-08-10T10:00:00Z");
        s.clock.set(afterAugust);
        const aug = await s.invoices.finalize((await s.invoices.generateDraft("org_a", "2026-08")).invoice._id, "test");
        // The trial expired on Aug 31 with $397.40 unused: written off with the August invoice.
        expect(aug.lapsedCredits).toEqual([{ grantId: expect.any(String), amount: 50_000n - 10_260n }]);

        await s.invoices.void(aug._id, "test", "wrong customer details");
        expect((await s.orgs.grants("org_a"))[0]?.remaining).toBe(50_000n);
        expect(await s.db.settlements.countDocuments()).toBe(0);
        await expect(s.invoices.markPaid(aug._id, "test", "pi_1")).rejects.toBeInstanceOf(InvalidTransitionError);

        const reissued = await s.invoices.generateDraft("org_a", "2026-08");
        expect(reissued.invoice._id).toBe("inv_org_a_2026-08_r1");
        const final = await s.invoices.finalize(reissued.invoice._id, "test");
        expect(final.number).toBe("QC-2026-000002");

        s.clock.set(new Date("2026-10-01T03:00:00Z"));
        const sep = await s.invoices.finalize((await s.invoices.generateDraft("org_a", "2026-09")).invoice._id, "test");
        await expect(s.invoices.void(final._id, "test", "late")).rejects.toThrow(/later invoices/);
        await s.invoices.markPaid(sep._id, "test", "pi_2");
        await expect(s.invoices.void(sep._id, "test", "paid")).rejects.toBeInstanceOf(InvalidTransitionError);
        expect((await s.audit.verify()).ok).toBe(true);
    });

    it("is safe under concurrent draft generation and finalization", async () => {
        const s = await setup();
        await createOrg(s, "org_a", { trial: 5_000n });
        await compute(s, "org_a", "1000", "2026-08-10T10:00:00Z");
        const drafts = await Promise.all(Array.from({ length: 6 }, () => s.invoices.generateDraft("org_a", "2026-08")));
        expect(new Set(drafts.map((d) => d.invoice._id)).size).toBe(1);
        expect(await s.db.invoices.countDocuments()).toBe(1);

        s.clock.set(afterAugust);
        const id = drafts[0]?.invoice._id ?? "";
        const results = await Promise.allSettled([s.invoices.finalize(id, "a"), s.invoices.finalize(id, "b"), s.invoices.finalize(id, "c")]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect((await s.orgs.grants("org_a"))[0]?.remaining).toBe(0n);
        expect(await s.db.counters.findOne({})).toMatchObject({ value: 1 });
        expect(await s.audit.verify()).toMatchObject({ ok: true });
    });

    it("prorates a mid-month upgrade", async () => {
        const s = await setup();
        await createOrg(s, "org_a", { planId: "developer" });
        s.clock.set(new Date("2026-08-11T00:00:00Z"));
        await s.orgs.changePlan("org_a", "scale", "test", new Date("2026-08-21T00:00:00Z"));
        s.clock.set(afterAugust);
        const { invoice } = await s.invoices.generateDraft("org_a", "2026-08");
        // 11 of 31 days of Scale's $99
        expect(invoice.lines.find((l) => l.kind === "base_fee")).toMatchObject({ amount: 3_513n, planId: "scale" });
        expect(invoice.lines.filter((l) => l.kind === "usage")).toHaveLength(6);
    });

    it("skips marketplace-billed orgs in the run and refuses to invoice them", async () => {
        const s = await setup();
        await createOrg(s, "org_a");
        await s.orgs.create({ _id: "org_m", name: "M", billing: { channel: "aws_marketplace", customerIdentifier: "cust-1", productCode: "prod-1" }, taxProfile: { country: "US" }, planId: "scale" });
        await expect(s.invoices.generateDraft("org_m", "2026-08")).rejects.toBeInstanceOf(MarketplaceBilledError);
        s.clock.set(afterAugust);
        const run = await runInvoices(s.invoices, s.orgs, "2026-08", { finalize: true });
        expect(run).toMatchObject({ orgs: 2, created: 1, finalized: 1, skippedMarketplace: 1, failed: [] });
        const again = await runInvoices(s.invoices, s.orgs, "2026-08", { finalize: true });
        expect(again).toMatchObject({ created: 0, finalized: 0, alreadyFinalized: 1, totalDue: run.totalDue });
    });

    it("detects an edited or deleted audit entry", async () => {
        const s = await setup();
        await createOrg(s, "org_a", { trial: 1_000n });
        await createOrg(s, "org_b", { trial: 1_000n });
        expect(await s.audit.verify()).toEqual({ ok: true, entries: 4 });
        await s.db.auditLog.updateOne({ _id: 2 }, { $set: { amount: 999_999n } });
        expect(await s.audit.verify()).toMatchObject({ ok: false, brokenAt: 2 });
        await s.db.auditLog.deleteOne({ _id: 2 });
        expect(await s.audit.verify()).toMatchObject({ ok: false, brokenAt: 2, reason: "missing entry" });
    });

    it("estimates the running bill and projects it to the end of the period", async () => {
        const s = await setup();
        await createOrg(s, "org_a", { country: "JP" });
        await compute(s, "org_a", "1000", "2026-08-01T05:00:00Z");
        s.clock.set(new Date("2026-08-01T12:30:00Z")); // 12 full hours of 744
        const est = await s.invoices.estimate("org_a");
        expect(est).toMatchObject({ period: "2026-08", elapsedHours: 12, totalHours: 744 });
        expect(est.accrued.total).toBe(9_900n + 360n);
        expect(est.projectedUsage.compute).toBe(parseFixed("62000", 6));
        expect(est.projectedTotal).toBe(9_900n + 22_320n);
        expect(monthPeriod(est.period).end.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    });
});
