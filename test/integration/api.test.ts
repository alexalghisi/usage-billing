import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApi } from "../../src/api/server.ts";
import { createServices, type Services } from "../../src/app/context.ts";
import { FixedClock } from "../../src/domain/time.ts";
import { testDatabase } from "../helpers/env.ts";
import { ingest, usage } from "../helpers/records.ts";

const clock = new FixedClock(new Date("2026-08-01T00:00:00Z"));
let s: Services;
let app: FastifyInstance;

beforeAll(async () => {
    s = createServices(await testDatabase("api"), clock);
    await s.orgs.create({ _id: "org_a", name: "Acme", billing: { channel: "invoice" }, taxProfile: { country: "FR", vatId: "FR12345678901" }, planId: "scale" });
    clock.set(new Date("2026-08-20T12:00:00Z"));
    await ingest(s.db, [usage("org_a", "compute", "1200.5", "2026-08-10T10:15:00Z", clock), usage("org_a", "compute", "300", "2026-08-10T11:15:00Z", clock, "svc_2")]);
    await s.aggregator.drain();
    app = buildApi(s);
});
afterAll(async () => {
    await app.close();
    await s.db.drop();
    await s.db.client.close();
});

describe("API", () => {
    it("serves usage series with bigint quantities as strings", async () => {
        const res = await app.inject({ url: "/api/orgs/org_a/usage?granularity=day&from=2026-08-01T00:00:00Z&to=2026-09-01T00:00:00Z" });
        expect(res.statusCode).toBe(200);
        expect(res.json().points).toEqual([{ bucket: "2026-08-10T00:00:00.000Z", quantities: { compute: "1500500000", storage: "0", transfer: "0" } }]);
    });

    it("serves a running estimate", async () => {
        const est = (await app.inject({ url: "/api/orgs/org_a/estimate" })).json();
        expect(est.period).toBe("2026-08");
        expect(est.accrued.tax.regime).toBe("reverse_charge");
        expect(BigInt(est.projectedTotal)).toBeGreaterThan(BigInt(est.accrued.total));
    });

    it("drills down from an invoice line to the rollups behind it", async () => {
        const run = (await app.inject({ method: "POST", url: "/api/admin/invoice-runs", payload: { period: "2026-08" } })).json();
        expect(run).toMatchObject({ created: 1, failed: [] });
        const list = (await app.inject({ url: "/api/orgs/org_a/invoices" })).json();
        expect(list[0]).not.toHaveProperty("lines");
        const id = list[0]._id as string;
        const drill = (await app.inject({ url: `/api/invoices/${id}/lines/${encodeURIComponent("usage:compute:0")}/usage` })).json();
        expect(drill.billedQuantity).toBe("1500500000");
        expect(drill.currentQuantity).toBe("1500500000");
        expect(drill.rollups.map((r: { serviceId: string; quantity: string }) => [r.serviceId, r.quantity])).toEqual([
            ["svc_1", "1200500000"],
            ["svc_2", "300000000"],
        ]);
    });

    it("enforces the invoice state machine with proper status codes", async () => {
        const id = "inv_org_a_2026-08";
        expect((await app.inject({ method: "POST", url: "/api/admin/invoice-runs", payload: { period: "2026-08", finalize: true } })).statusCode).toBe(422);
        expect((await app.inject({ method: "POST", url: `/api/invoices/${id}/pay`, payload: { reference: "x" } })).statusCode).toBe(409);
        clock.set(new Date("2026-09-01T03:00:00Z"));
        const fin = await app.inject({ method: "POST", url: `/api/invoices/${id}/finalize` });
        expect(fin.statusCode).toBe(200);
        expect(fin.json()).toMatchObject({ status: "finalized", number: "QC-2026-000001" });
        expect((await app.inject({ method: "POST", url: `/api/invoices/${id}/finalize` })).statusCode).toBe(409);
        expect((await app.inject({ method: "POST", url: `/api/invoices/${id}/void`, payload: {} })).statusCode).toBe(400);
        expect((await app.inject({ method: "POST", url: `/api/invoices/${id}/pay`, payload: { reference: "pi_123" } })).json().status).toBe("paid");
        expect((await app.inject({ url: `/api/invoices/${id}` })).json().verified).toBe(true);
        expect((await app.inject({ url: "/api/admin/audit/verify" })).json()).toMatchObject({ ok: true });
        expect((await app.inject({ url: "/api/invoices/nope" })).statusCode).toBe(404);
    });

    it("reports reconciliation", async () => {
        const report = (await app.inject({ url: "/api/admin/reconcile?period=2026-08" })).json();
        expect(report).toMatchObject({ rawRecords: 2, mismatches: [] });
    });
});
