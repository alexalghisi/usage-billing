import { MongoClient, type Collection, type Db } from "mongodb";
import type { UsageRecord } from "../metering/record.ts";
import type { Rejection } from "../metering/usage-store.ts";
import type { DailyRollup, HourlyRollup } from "../rollups/types.ts";

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

    async ensureIndexes(): Promise<void> {
        await this.usageRecords.createIndex({ orgId: 1, hour: 1 });
        await this.dirtyHours.createIndex({ markedAt: 1 });
        await this.rejectedRecords.createIndex({ rejectedAt: 1 });
        await this.hourlyRollups.createIndex({ orgId: 1, hour: 1 });
        await this.hourlyRollups.createIndex({ hour: 1 });
        await this.dailyRollups.createIndex({ orgId: 1, day: 1 });
    }

    async drop(): Promise<void> {
        await this.db.dropDatabase();
    }
}

export async function connectDatabase(uri: string, dbName: string): Promise<Database> {
    // useBigInt64: quantities and money are stored as Int64 and read back as bigint, never as JS numbers.
    const client = await MongoClient.connect(uri, { useBigInt64: true, maxPoolSize: 20 });
    const database = new Database(client, dbName);
    await database.ensureIndexes();
    return database;
}
