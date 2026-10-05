// End-to-end month simulation: generates a month of usage for N orgs, pushes it
// through SQS -> handler -> MongoDB -> rollups -> invoices and marketplace
// reports, and compares every invoice with an independent calculation.
//   npm run simulate -- --orgs 50 --seed 2026
import { parseArgs } from "node:util";
import { connectDatabase } from "../infra/mongo.ts";
import { createSqsClient, ensureQueue } from "../infra/sqs.ts";
import { formatUsd } from "../money/money.ts";
import { runMonthSimulation } from "../sim/month-simulation.ts";
import { startLocalEnv } from "./local-env.ts";

const { values } = parseArgs({ options: { orgs: { type: "string", default: "50" }, seed: { type: "string", default: "2026" }, rows: { type: "string", default: "12" } } });
const orgs = Number(values.orgs);
const seed = Number(values.seed);

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const n = (v: number | bigint) => v.toLocaleString("en-US");

const env = await startLocalEnv({ sqsPort: Number(process.env.SQS_PORT ?? 9335) });
const db = await connectDatabase(env.mongoUri, `ub_sim_${Date.now()}`);
const sqs = createSqsClient(env.sqsEndpoint);
const queue = await ensureQueue(sqs, `usage-sim-${Date.now()}`, 5);
try {
    process.stdout.write(`${bold("usage-billing month simulation")} ${dim(`2026-09 plus the first 3 days of 2026-10, seed ${seed}`)}\n\n`);
    const r = await runMonthSimulation({ orgs, seed, onProgress: (m) => process.stdout.write(dim(`  ${m}\n`)) }, { db, sqs, ...queue });
    const invoiced = r.comparisons.length / 2;
    const [sep, oct] = r.invoiceRuns;
    process.stdout.write("\n");
    process.stdout.write(`${bold("orgs")}         ${r.orgs} (${invoiced} invoiced, ${r.orgs - invoiced} billed through AWS Marketplace)\n`);
    process.stdout.write(`${bold("metering")}     ${n(r.records)} records in ${n(r.messages)} SQS messages, ${n(r.resent)} resent, ${r.malformedMessages} malformed\n`);
    process.stdout.write(`             stored ${n(r.ingest.inserted)} once, ${n(r.ingest.duplicates)} duplicates ignored, ${r.ingest.rejected} rejected, ${r.deadLettered} dead-lettered\n`);
    process.stdout.write(`             ${r.ingest.seconds.toFixed(1)} s, ${n(r.ingest.recordsPerSecond)} records/s ${dim("(SQS -> handler -> MongoDB -> dirty hours)")}\n`);
    process.stdout.write(`${bold("rollups")}      reconciliation against raw records: ${r.reconcileMismatches === 0 ? green("0 mismatches") : red(`${r.reconcileMismatches} mismatches`)}\n`);
    process.stdout.write(`${bold("invoices")}     2026-09: ${sep?.finalized} finalized in ${((sep?.durationMs ?? 0) / 1000).toFixed(1)} s, 2026-10: ${oct?.finalized} finalized in ${((oct?.durationMs ?? 0) / 1000).toFixed(1)} s, ${r.adjustmentLines} adjustment lines for late usage\n`);
    const m = r.marketplace;
    process.stdout.write(`${bold("marketplace")}  ${n(m.reportedUnits)} of ${n(m.expectedUnits)} units reported; ${n(m.stats.failedRequests)} injected failures, ${n(m.stats.duplicates)} retries deduplicated, ${m.unresolvedReports} unresolved\n`);
    process.stdout.write(`${bold("audit")}        ${n(r.auditEntries)} entries, hash chain ${r.auditOk ? green("verified") : red("BROKEN")}, finalized invoices ${r.invoicesVerified ? green("untampered") : red("MODIFIED")}\n\n`);

    const header = ["org", "period", "subtotal", "discount", "credits", "tax", "total", "oracle", ""];
    const widths = [10, 8, 13, 11, 11, 11, 13, 13, 4];
    const row = (cells: string[]) => cells.map((c, i) => (i < 2 ? c.padEnd(widths[i] ?? 10) : c.padStart(widths[i] ?? 10))).join(" ");
    process.stdout.write(dim(row(header)) + "\n");
    for (const c of r.comparisons.slice(0, Number(values.rows))) {
        const a = c.actual;
        process.stdout.write(
            row([c.orgId, c.period, formatUsd(a.subtotal), formatUsd(-a.discount), formatUsd(-a.credits), formatUsd(a.tax), formatUsd(a.total), formatUsd(c.expected.total), c.match ? green("ok") : red("DIFF")]) + "\n",
        );
    }
    if (r.comparisons.length > Number(values.rows)) process.stdout.write(dim(`... ${r.comparisons.length - Number(values.rows)} more\n`));
    const billed = r.comparisons.reduce((acc, c) => acc + c.actual.total, 0n);
    process.stdout.write(
        `\n${r.mismatches.length === 0 ? green(bold(`${r.comparisons.length}/${r.comparisons.length} invoices match the independent calculation to the cent`)) : red(bold(`${r.mismatches.length} invoices differ`))} ${dim(`(${formatUsd(billed)} billed)`)}\n`,
    );
    process.exitCode = r.mismatches.length === 0 && m.mismatched.length === 0 && r.auditOk ? 0 : 1;
} finally {
    await db.drop();
    await db.client.close();
    sqs.destroy();
    await env.stop();
}
