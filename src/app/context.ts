import { AuditLog } from "../audit/audit-log.ts";
import type { Clock } from "../domain/time.ts";
import { InvoiceService } from "../invoicing/invoice-service.ts";
import type { Database } from "../infra/mongo.ts";
import { OrgService } from "../orgs/org-service.ts";
import { defaultCatalog } from "../rating/catalog.ts";
import type { PlanCatalog } from "../rating/plan.ts";
import { Aggregator } from "../rollups/aggregator.ts";
import { UsageQuery } from "../rollups/usage-query.ts";
import { StaticTaxProvider } from "../tax/static-provider.ts";
import type { TaxProvider } from "../tax/tax.ts";

/** The seller of record for the fictional service: an Irish company. */
export const SELLER = { country: "IE", invoicePrefix: "QC" };

export interface Services {
    db: Database;
    clock: Clock;
    catalog: PlanCatalog;
    audit: AuditLog;
    orgs: OrgService;
    usage: UsageQuery;
    invoices: InvoiceService;
    aggregator: Aggregator;
}

export function createServices(db: Database, clock: Clock, overrides: { tax?: TaxProvider; catalog?: PlanCatalog } = {}): Services {
    const catalog = overrides.catalog ?? defaultCatalog;
    const audit = new AuditLog(db, () => clock.now());
    const orgs = new OrgService({ db, audit, clock, catalog });
    const usage = new UsageQuery(db);
    const invoices = new InvoiceService({ db, catalog, tax: overrides.tax ?? new StaticTaxProvider(), clock, audit, orgs, usage, seller: SELLER });
    return { db, clock, catalog, audit, orgs, usage, invoices, aggregator: new Aggregator(db, clock) };
}
