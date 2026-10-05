import { MongoClient, type Collection, type Db } from "mongodb";
import type { UsageRecord } from "../metering/record.ts";
import type { Rejection } from "../metering/usage-store.ts";
import type { DailyRollup, HourlyRollup } from "../rollups/types.ts";
import type { AuditEntry, AuditHead } from "../audit/audit-log.ts";
import type { Invoice, Settlement } from "../invoicing/invoice.ts";
import type { Org } from "../orgs/org.ts";
import type { CreditGrant } from "../rating/credits.ts";

export interface Counter {
    _id: string;
    value: number;
}

export interface DirtyHour {
    _id: string;
    orgId: string;
    hour: Date;
    /** Changes on every mark; the aggregator only clears a marker whose token it has seen. */
    token: string;
    markedAt: Date;
}

export class Database {
    readonly client: MongoClient;
    readonly db: Db;
    constructor(client: MongoClient, dbName: string) {
        this.client = client;
        this.db = client.db(dbName);
    }

    get usageRecords(): Collection<UsageRecord> {
        return this.db.collection<UsageRecord>("usage_records");
    }
    get dirtyHours(): Collection<DirtyHour> {
        return this.db.collection<DirtyHour>("dirty_hours");
    }
    get rejectedRecords(): Collection<Rejection> {
        return this.db.collection<Rejection>("rejected_records");
    }

    get hourlyRollups(): Collection<HourlyRollup> {
        return this.db.collection<HourlyRollup>("rollups_hourly");
    }
    get dailyRollups(): Collection<DailyRollup> {
        return this.db.collection<DailyRollup>("rollups_daily");
    }

    get orgs(): Collection<Org> {
        return this.db.collection<Org>("orgs");
    }
    get creditGrants(): Collection<CreditGrant> {
        return this.db.collection<CreditGrant>("credit_grants");
    }
    get invoices(): Collection<Invoice> {
        return this.db.collection<Invoice>("invoices");
    }
    get settlements(): Collection<Settlement> {
        return this.db.collection<Settlement>("settlements");
    }
    get counters(): Collection<Counter> {
        return this.db.collection<Counter>("counters");
    }
    get auditLog(): Collection<AuditEntry> {
        return this.db.collection<AuditEntry>("audit_log");
    }
    get auditHead(): Collection<AuditHead> {
        return this.db.collection<AuditHead>("audit_head");
    }

    async ensureIndexes(): Promise<void> {
        await this.usageRecords.createIndex({ orgId: 1, hour: 1 });
        await this.dirtyHours.createIndex({ orgId: 1, hour: 1 });
        await this.rejectedRecords.createIndex({ rejectedAt: 1 });
        await this.hourlyRollups.createIndex({ orgId: 1, hour: 1 });
        await this.hourlyRollups.createIndex({ hour: 1 });
        await this.dailyRollups.createIndex({ orgId: 1, day: 1 });
        await this.creditGrants.createIndex({ orgId: 1 });
        await this.invoices.createIndex({ activeKey: 1 }, { unique: true, sparse: true });
        await this.invoices.createIndex({ orgId: 1, periodStart: -1 });
        await this.invoices.createIndex({ period: 1, status: 1 });
        await this.settlements.createIndex({ orgId: 1, period: 1 });
        await this.auditLog.createIndex({ orgId: 1, _id: -1 });
        await this.auditLog.createIndex({ entityId: 1 });
    }

    async drop(): Promise<void> {
        await this.db.dropDatabase();
    }
}

export async function connectDatabase(uri: string, dbName: string): Promise<Database> {
    // useBigInt64: quantities and money are stored as Int64 and read back as bigint, never as JS numbers.
    const client = await MongoClient.connect(uri, { useBigInt64: true, ignoreUndefined: true, maxPoolSize: 20 });
    const database = new Database(client, dbName);
    await database.ensureIndexes();
    return database;
}
