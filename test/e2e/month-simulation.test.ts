import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../src/infra/mongo.ts";
import { runMonthSimulation, type SimulationReport } from "../../src/sim/month-simulation.ts";
import { testDatabase, testQueue } from "../helpers/env.ts";

describe("month simulation", () => {
    let db: Database;
    let report: SimulationReport;

    beforeAll(async () => {
        db = await testDatabase("sim");
        const q = await testQueue("sim", 5);
        report = await runMonthSimulation({ orgs: 12, seed: 2026 }, { db, ...q });
    }, 600_000);
    afterAll(async () => {
        await db.drop();
        await db.client.close();
    });

    it("bills every invoice to the cent of an independent calculation", () => {
        expect(report.comparisons).toHaveLength(2 * 10); // 12 orgs, 2 billed through the marketplace
        expect(report.mismatches).toEqual([]);
    });

    it("turned usage that arrived after finalization into adjustments", () => {
        expect(report.adjustmentLines).toBeGreaterThan(0);
    });

    it("ingested every record once despite resends and malformed messages", () => {
        expect(report.ingest.inserted).toBe(report.records);
        expect(report.ingest.duplicates).toBe(report.resent);
        expect(report.ingest.rejected).toBe(3);
        expect(report.deadLettered).toBe(0);
        expect(report.reconcileMismatches).toBe(0);
    });

    it("reported the metered whole units to the marketplace despite injected faults, never more", () => {
        const m = report.marketplace;
        expect(m.dimensions).toBe(6);
        expect(m.mismatched).toEqual([]);
        expect(m.reportedUnits + m.unresolvedMissingUnits).toBe(m.expectedUnits);
        expect(m.reportedUnits <= m.expectedUnits).toBe(true);
    });

    it("left a verifiable audit trail and untampered invoices", () => {
        expect(report.auditOk).toBe(true);
        expect(report.invoicesVerified).toBe(true);
        expect(report.invoiceRuns.map((r) => r.failed)).toEqual([[], []]);
    });
});
