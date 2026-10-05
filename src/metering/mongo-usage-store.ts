import { randomUUID } from "node:crypto";
import { MongoBulkWriteError, type AnyBulkWriteOperation } from "mongodb";
import type { Database, DirtyHour } from "../infra/mongo.ts";
import type { UsageRecord } from "./record.ts";
import type { InsertOutcome, OrgHour, Rejection, UsageStore } from "./usage-store.ts";

const DUPLICATE_KEY = 11000;

export class MongoUsageStore implements UsageStore {
    private readonly database: Database;
    constructor(database: Database) {
        this.database = database;
    }

    async insert(records: readonly UsageRecord[]): Promise<InsertOutcome[]> {
        const outcomes: InsertOutcome[] = records.map(() => "inserted");
        if (records.length === 0) return outcomes;
        const duplicates: number[] = [];
        try {
            await this.database.usageRecords.insertMany([...records], { ordered: false });
        } catch (error) {
            if (!(error instanceof MongoBulkWriteError)) throw error;
            const writeErrors = Array.isArray(error.writeErrors) ? error.writeErrors : [error.writeErrors];
            for (const writeError of writeErrors) {
                if (writeError.code === DUPLICATE_KEY) duplicates.push(writeError.index);
                else outcomes[writeError.index] = "failed";
            }
        }
        if (duplicates.length > 0) {
            // A duplicate id is only harmless if it carries the same payload; otherwise a producer reused an event id.
            const ids = duplicates.map((i) => records[i]?._id).filter((id): id is string => id !== undefined);
            const existing = await this.database.usageRecords.find({ _id: { $in: ids } }, { projection: { payloadHash: 1 } }).toArray();
            const hashes = new Map(existing.map((doc) => [doc._id, doc.payloadHash]));
            for (const i of duplicates) {
                const record = records[i];
                if (record) outcomes[i] = hashes.get(record._id) === record.payloadHash ? "duplicate" : "conflict";
            }
        }
        return outcomes;
    }

    async markDirty(keys: readonly OrgHour[]): Promise<void> {
        if (keys.length === 0) return;
        const now = new Date();
        const ops: AnyBulkWriteOperation<DirtyHour>[] = keys.map((k) => ({
            updateOne: {
                filter: { _id: dirtyHourId(k) },
                update: { $set: { orgId: k.orgId, hour: k.hour, token: randomUUID(), markedAt: now } },
                upsert: true,
            },
        }));
        await this.database.dirtyHours.bulkWrite(ops, { ordered: false });
    }

    async reject(rejections: readonly Rejection[]): Promise<void> {
        if (rejections.length > 0) await this.database.rejectedRecords.insertMany(rejections.map((r) => ({ ...r })));
    }
}

export function dirtyHourId(k: OrgHour): string {
    return `${k.orgId}|${k.hour.toISOString()}`;
}
