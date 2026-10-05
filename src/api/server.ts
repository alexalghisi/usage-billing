import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { Services } from "../app/context.ts";
import { isMeter } from "../domain/meters.ts";
import { DAY_MS, HOUR_MS, monthPeriod, periodKey, startOfHour } from "../domain/time.ts";
import { InvalidTransitionError } from "../invoicing/invoice.ts";
import { MarketplaceBilledError } from "../invoicing/invoice-service.ts";
import { runInvoices } from "../invoicing/invoice-run.ts";
import type { MarketplaceReporter } from "../marketplace/reporter.ts";
import { NotFoundError } from "../orgs/org-service.ts";
import { reconcile } from "../rollups/reconcile.ts";
import { HOUR_CLOSE_GRACE_MS } from "../rollups/types.ts";

/** bigint values (money in cents, quantities in micro-units) are sent as decimal strings. */
function serialize(payload: unknown): string {
    return JSON.stringify(payload, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
}

const dateParam = z.iso.datetime().transform((s) => new Date(s));

export function buildApi(services: Services, extras: { reporter?: MarketplaceReporter } = {}): FastifyInstance {
    const app = Fastify({ logger: false });
    const { orgs, invoices, usage, audit, clock, db } = services;
    app.setReplySerializer(serialize);

    app.setErrorHandler((error, _req, reply) => {
        if (error instanceof NotFoundError) return reply.status(404).send({ error: error.message });
        if (error instanceof InvalidTransitionError || error instanceof MarketplaceBilledError) return reply.status(409).send({ error: error.message });
        if (error instanceof z.ZodError) return reply.status(400).send({ error: "invalid request", issues: error.issues });
        const status = (error as { statusCode?: number }).statusCode;
        if (status && status < 500) return reply.status(status).send({ error: (error as Error).message });
        return reply.status(422).send({ error: (error as Error).message });
    });

    app.get("/api/health", async () => ({ ok: true }));
    app.get("/api/clock", async () => ({ now: clock.now(), period: periodKey(clock.now()) }));
    app.get("/api/plans", async () => services.catalog.all());

    app.get("/api/orgs", async () => {
        const all = await orgs.list();
        const now = clock.now();
        return all.map((o) => ({
            id: o._id,
            name: o.name,
            channel: o.billing.channel,
            country: o.taxProfile.country,
            planId: [...o.plans].reverse().find((p) => p.effectiveFrom <= now)?.planId ?? o.plans[0]?.planId,
        }));
    });

    app.get<{ Params: { orgId: string } }>("/api/orgs/:orgId", async (req) => {
        const org = await orgs.get(req.params.orgId);
        return { ...org, grants: await orgs.grants(org._id) };
    });

    app.get<{ Params: { orgId: string }; Querystring: Record<string, string> }>("/api/orgs/:orgId/usage", async (req) => {
        const q = z
            .object({ from: dateParam.optional(), to: dateParam.optional(), granularity: z.enum(["hour", "day"]).default("hour") })
            .parse(req.query);
        const to = q.to ?? new Date(startOfHour(clock.now()).getTime() + HOUR_MS);
        const from = q.from ?? (q.granularity === "hour" ? new Date(to.getTime() - 72 * HOUR_MS) : new Date(to.getTime() - 60 * DAY_MS));
        await orgs.get(req.params.orgId);
        const points = await usage.series(req.params.orgId, from, to, q.granularity);
        return { from, to, granularity: q.granularity, points };
    });

    app.get<{ Params: { orgId: string } }>("/api/orgs/:orgId/estimate", async (req) => invoices.estimate(req.params.orgId));

    app.get<{ Params: { orgId: string } }>("/api/orgs/:orgId/invoices", async (req) => {
        await orgs.get(req.params.orgId);
        return (await invoices.list(req.params.orgId)).map(({ lines: _lines, ...summary }) => summary);
    });

    app.get<{ Params: { orgId: string } }>("/api/orgs/:orgId/marketplace-reports", async (req) => (extras.reporter ? extras.reporter.list(req.params.orgId) : []));

    app.get<{ Params: { orgId: string } }>("/api/orgs/:orgId/audit", async (req) => audit.list({ orgId: req.params.orgId, limit: 200 }));

    app.post<{ Params: { orgId: string } }>("/api/orgs/:orgId/plan", async (req) => {
        const body = z.object({ planId: z.string(), effectiveFrom: dateParam.optional() }).parse(req.body);
        return orgs.changePlan(req.params.orgId, body.planId, "api", body.effectiveFrom);
    });

    app.get<{ Params: { id: string } }>("/api/invoices/:id", async (req) => {
        const inv = await invoices.get(req.params.id);
        return { ...inv, verified: invoices.verify(inv) };
    });

    // Drill-down: the hourly rollups an invoice line was computed from, and what they add up to now.
    app.get<{ Params: { id: string; lineId: string } }>("/api/invoices/:id/lines/:lineId/usage", async (req, reply) => {
        const inv = await invoices.get(req.params.id);
        const line = inv.lines.find((l) => l.id === req.params.lineId);
        if (!line) return reply.status(404).send({ error: "line not found" });
        if (line.kind === "adjustment") {
            const adj = inv.adjustments.find((a) => a.period === line.adjustsPeriod);
            return { line, adjustment: adj };
        }
        if (!line.source || !line.meter || !isMeter(line.meter)) return { line, rollups: [] };
        const rollups = await usage.rollups(line.source.orgId, line.source.meter, line.source.from, line.source.to);
        const current = rollups.reduce((acc, r) => acc + r.quantity, 0n);
        const late = rollups.reduce((acc, r) => acc + r.lateRecords, 0);
        return {
            line,
            billedQuantity: line.quantity,
            currentQuantity: current,
            changedSinceInvoiced: current !== line.quantity,
            lateRecords: late,
            rollups: rollups.map((r) => ({ hour: r.hour, serviceId: r.serviceId, quantity: r.quantity, recordCount: r.recordCount, lateRecords: r.lateRecords, updatedAt: r.updatedAt })),
        };
    });

    app.post<{ Params: { id: string } }>("/api/invoices/:id/finalize", async (req) => invoices.finalize(req.params.id, "api"));
    app.post<{ Params: { id: string } }>("/api/invoices/:id/pay", async (req) => {
        const body = z.object({ reference: z.string().min(1) }).parse(req.body ?? {});
        return invoices.markPaid(req.params.id, "api", body.reference);
    });
    app.post<{ Params: { id: string } }>("/api/invoices/:id/void", async (req) => {
        const body = z.object({ reason: z.string().min(3) }).parse(req.body ?? {});
        return invoices.void(req.params.id, "api", body.reason);
    });

    app.post("/api/admin/invoice-runs", async (req) => {
        const body = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/), finalize: z.boolean().default(false) }).parse(req.body ?? {});
        const period = monthPeriod(body.period);
        if (body.finalize && clock.now().getTime() < period.end.getTime() + HOUR_CLOSE_GRACE_MS) throw new Error(`period ${body.period} has not closed yet`);
        return runInvoices(invoices, orgs, body.period, { finalize: body.finalize, actor: "api" });
    });

    app.get<{ Querystring: Record<string, string> }>("/api/admin/reconcile", async (req) => {
        const q = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/).optional(), orgId: z.string().optional() }).parse(req.query);
        const period = monthPeriod(q.period ?? periodKey(clock.now()));
        return reconcile(db, { from: period.start, to: period.end, ...(q.orgId ? { orgId: q.orgId } : {}) });
    });

    app.get("/api/admin/audit/verify", async () => audit.verify());

    return app;
}
