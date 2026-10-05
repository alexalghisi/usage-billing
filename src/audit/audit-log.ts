import type { ClientSession } from "mongodb";
import { canonicalJson, sha256 } from "../infra/canonical.ts";
import type { Database } from "../infra/mongo.ts";
import type { Cents } from "../money/money.ts";

export interface AuditInput {
    actor: string;
    action: string;
    entityType: "invoice" | "credit_grant" | "org" | "settlement" | "marketplace_report";
    entityId: string;
    orgId?: string;
    /** Signed change of the entity's money value: an invoice's total, a grant's balance, a settlement's net. */
    amount?: Cents;
    data?: Record<string, unknown>;
}

export interface AuditEntry extends AuditInput {
    _id: number;
    at: Date;
    prevHash: string;
    hash: string;
}

export interface AuditHead {
    _id: "head";
    seq: number;
    hash: string;
}

const GENESIS = "0".repeat(64);

function entryHash(prevHash: string, entry: Omit<AuditEntry, "hash" | "prevHash">): string {
    return sha256(prevHash + canonicalJson(entry));
}

/**
 * Append-only, hash-chained log of every money-affecting change. Entries are
 * written in the same transaction as the change they describe, so the log can
 * never disagree with the data. The chain head is a single document: concurrent
 * appends conflict on it and the transaction is retried, which keeps sequence
 * numbers gapless. verify() recomputes the chain and finds edited or removed entries.
 */
export class AuditLog {
    private readonly db: Database;
    private readonly now: () => Date;
    constructor(db: Database, now: () => Date) {
        this.db = db;
        this.now = now;
    }

    async append(session: ClientSession, inputs: AuditInput | AuditInput[]): Promise<AuditEntry[]> {
        if (!session.inTransaction()) throw new Error("audit entries must be appended inside a transaction");
        const list = Array.isArray(inputs) ? inputs : [inputs];
        if (list.length === 0) return [];
        const head = (await this.db.auditHead.findOne({ _id: "head" }, { session })) ?? { _id: "head" as const, seq: 0, hash: GENESIS };
        let { seq, hash } = head;
        const entries: AuditEntry[] = [];
        for (const input of list) {
            seq += 1;
            const body = { ...input, _id: seq, at: this.now() };
            const next = entryHash(hash, body);
            entries.push({ ...body, prevHash: hash, hash: next });
            hash = next;
        }
        await this.db.auditHead.updateOne({ _id: "head" }, { $set: { seq, hash } }, { upsert: true, session });
        await this.db.auditLog.insertMany(entries, { session });
        return entries;
    }

    async verify(): Promise<{ ok: true; entries: number } | { ok: false; brokenAt: number; reason: string }> {
        let prev = GENESIS;
        let expectedSeq = 1;
        for await (const entry of this.db.auditLog.find({}).sort({ _id: 1 })) {
            if (entry._id !== expectedSeq) return { ok: false, brokenAt: expectedSeq, reason: "missing entry" };
            const { hash, prevHash, ...body } = entry;
            if (prevHash !== prev || entryHash(prev, body) !== hash) return { ok: false, brokenAt: entry._id, reason: "hash mismatch" };
            prev = hash;
            expectedSeq++;
        }
        const head = await this.db.auditHead.findOne({ _id: "head" });
        if (head && (head.seq !== expectedSeq - 1 || head.hash !== prev)) return { ok: false, brokenAt: expectedSeq, reason: "entries missing at the end" };
        return { ok: true, entries: expectedSeq - 1 };
    }

    async list(filter: { orgId?: string; entityId?: string; limit?: number }): Promise<AuditEntry[]> {
        const query: Record<string, string> = {};
        if (filter.orgId) query.orgId = filter.orgId;
        if (filter.entityId) query.entityId = filter.entityId;
        return this.db.auditLog.find(query).sort({ _id: -1 }).limit(filter.limit ?? 100).toArray();
    }
}
