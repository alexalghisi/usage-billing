// Lambda entry points. Each is a thin adapter from the AWS event to the same
// code the local poller, CLI and tests run.
import type { ScheduledEvent, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { periodKey, previousPeriodKey, systemClock } from "../domain/time.ts";
import { runInvoices } from "../invoicing/invoice-run.ts";
import { AwsMeteringClient } from "../marketplace/metering-client.ts";
import { MarketplaceReporter } from "../marketplace/reporter.ts";
import { createUsageHandler } from "../metering/handler.ts";
import { MongoUsageStore } from "../metering/mongo-usage-store.ts";
import { getServices, logger } from "./runtime.ts";

/** SQS trigger with ReportBatchItemFailures. */
export async function ingestUsage(event: SQSEvent): Promise<SQSBatchResponse> {
    const { db } = await getServices();
    return createUsageHandler({ store: new MongoUsageStore(db), clock: systemClock, logger })(event);
}

/** Every minute: rebuild rollups for flagged org-hours. */
export async function aggregateRollups(_event: ScheduledEvent): Promise<void> {
    const { aggregator } = await getServices();
    await aggregator.runOnce();
}

/** Every hour, a few minutes past: report closed hours to AWS Marketplace. */
export async function reportMarketplaceUsage(_event: ScheduledEvent): Promise<void> {
    const s = await getServices();
    const reporter = new MarketplaceReporter({ db: s.db, client: new AwsMeteringClient({}), clock: systemClock, usage: s.usage, audit: s.audit, logger });
    await reporter.runOnce();
}

/** On the 1st of the month, after the grace period: finalize last month's invoices. */
export async function monthlyInvoiceRun(_event: ScheduledEvent): Promise<void> {
    const s = await getServices();
    const result = await runInvoices(s.invoices, s.orgs, previousPeriodKey(periodKey(systemClock.now())), { finalize: true, logger });
    if (result.failed.length > 0) throw new Error(`${result.failed.length} invoices failed; the run is safe to retry`);
}
