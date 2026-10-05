import { silentLogger, type Logger } from "../infra/logger.ts";
import { mapPool } from "../infra/pool.ts";
import type { Cents } from "../money/money.ts";
import type { OrgService } from "../orgs/org-service.ts";
import type { InvoiceService } from "./invoice-service.ts";

export interface InvoiceRunResult {
    period: string;
    orgs: number;
    created: number;
    updated: number;
    unchanged: number;
    finalized: number;
    alreadyFinalized: number;
    skippedMarketplace: number;
    failed: { orgId: string; error: string }[];
    totalDue: Cents;
    durationMs: number;
}

/**
 * The monthly run: a draft for every invoice-billed org, optionally finalized.
 * Re-running it is safe; it picks up where a crashed run stopped and leaves
 * finalized invoices alone. One org failing does not stop the others.
 */
export async function runInvoices(
    invoices: InvoiceService,
    orgs: OrgService,
    period: string,
    options: { finalize: boolean; concurrency?: number; actor?: string; logger?: Logger },
): Promise<InvoiceRunResult> {
    const started = performance.now();
    const logger = options.logger ?? silentLogger;
    const all = await orgs.list();
    const result: InvoiceRunResult = {
        period,
        orgs: all.length,
        created: 0,
        updated: 0,
        unchanged: 0,
        finalized: 0,
        alreadyFinalized: 0,
        skippedMarketplace: 0,
        failed: [],
        totalDue: 0n,
        durationMs: 0,
    };
    await mapPool(all, options.concurrency ?? 8, async (org) => {
        if (org.billing.channel !== "invoice") {
            result.skippedMarketplace++;
            return;
        }
        try {
            const { invoice, outcome } = await invoices.generateDraft(org._id, period);
            if (outcome === "finalized") {
                result.alreadyFinalized++;
                if (invoice.status !== "void") result.totalDue += invoice.amountDue;
                return;
            }
            result[outcome]++;
            if (options.finalize) {
                const final = await invoices.finalize(invoice._id, options.actor ?? "invoice-run");
                result.finalized++;
                result.totalDue += final.amountDue;
            } else {
                result.totalDue += invoice.amountDue;
            }
        } catch (error) {
            logger.error("invoice failed", { orgId: org._id, period, error: String(error) });
            result.failed.push({ orgId: org._id, error: String(error) });
        }
    });
    result.durationMs = Math.round(performance.now() - started);
    logger.info("invoice run finished", { ...result, failed: result.failed.length });
    return result;
}
