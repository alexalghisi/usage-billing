import type { SQSBatchItemFailure, SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { Clock } from "../domain/time.ts";
import { silentLogger, type Logger } from "../infra/logger.ts";
import { usageEnvelope, validateRecord, type UsageRecord } from "./record.ts";
import type { OrgHour, Rejection, UsageStore } from "./usage-store.ts";

export interface IngestStats {
    messages: number;
    inserted: number;
    duplicates: number;
    rejected: number;
    failedMessages: number;
}

export interface UsageHandlerDeps {
    store: UsageStore;
    clock: Clock;
    logger?: Logger;
    onStats?: (stats: IngestStats) => void;
}

interface Pending {
    record: UsageRecord;
    messageId: string;
}

const MAX_REJECTED_PAYLOAD = 4096;

/**
 * SQS-triggered ingestion handler. Malformed input is acknowledged and parked
 * in the rejected collection because retrying it can never succeed; storage
 * errors are reported as batch item failures so SQS redelivers just those
 * messages (ReportBatchItemFailures). Everything is safe to redeliver.
 */
export function createUsageHandler(deps: UsageHandlerDeps): (event: SQSEvent) => Promise<SQSBatchResponse> {
    const logger = deps.logger ?? silentLogger;
    return async (event) => {
        const failed = new Set<string>();
        const rejections: Rejection[] = [];
        const pending: Pending[] = [];
        const reject = (messageId: string, reason: string, payload: string) =>
            rejections.push({ messageId, reason, payload: payload.slice(0, MAX_REJECTED_PAYLOAD), rejectedAt: deps.clock.now() });

        for (const message of event.Records) {
            let body: unknown;
            try {
                body = JSON.parse(message.body);
            } catch {
                reject(message.messageId, "body: not JSON", message.body);
                continue;
            }
            const envelope = usageEnvelope.safeParse(body);
            if (!envelope.success) {
                reject(message.messageId, "body: expected {records: [...]} with 1-1000 records", message.body);
                continue;
            }
            for (const raw of envelope.data.records) {
                const result = validateRecord(raw, deps.clock);
                if (result.ok) pending.push({ record: result.record, messageId: message.messageId });
                else reject(message.messageId, result.reason, JSON.stringify(raw));
            }
        }

        // The same record may appear twice in one batch (producer retry); only the first copy is written.
        const firstById = new Map<string, Pending>();
        const batchDuplicates: Pending[] = [];
        for (const p of pending) {
            const first = firstById.get(p.record._id);
            if (!first) firstById.set(p.record._id, p);
            else if (first.record.payloadHash !== p.record.payloadHash) reject(p.messageId, "conflicting duplicate in batch", JSON.stringify(p.record._id));
            else batchDuplicates.push(p);
        }
        const unique = [...firstById.values()];

        let inserted = 0;
        let duplicates = batchDuplicates.length;
        const settled: Pending[] = [...batchDuplicates];
        if (unique.length > 0) {
            try {
                const outcomes = await deps.store.insert(unique.map((p) => p.record));
                outcomes.forEach((outcome, i) => {
                    const p = unique[i];
                    if (!p) return;
                    if (outcome === "inserted") {
                        inserted++;
                        settled.push(p);
                    } else if (outcome === "duplicate") {
                        duplicates++;
                        settled.push(p);
                    } else if (outcome === "conflict") {
                        reject(p.messageId, "conflicting duplicate: same record id with different quantity or timestamp", p.record._id);
                    } else {
                        failed.add(p.messageId);
                    }
                });
            } catch (error) {
                logger.error("usage insert failed", { error: String(error), records: unique.length });
                for (const p of unique) failed.add(p.messageId);
            }
        }

        // Duplicates are marked too: if a previous attempt inserted but failed before marking, the retry repairs it.
        const dirty = new Map<string, OrgHour>();
        for (const p of settled) {
            if (failed.has(p.messageId)) continue;
            dirty.set(`${p.record.orgId}|${p.record.hour.getTime()}`, { orgId: p.record.orgId, hour: p.record.hour });
        }
        if (dirty.size > 0) {
            try {
                await deps.store.markDirty([...dirty.values()]);
            } catch (error) {
                logger.error("marking dirty hours failed", { error: String(error) });
                for (const p of settled) failed.add(p.messageId);
            }
        }

        const toPark = rejections.filter((r) => !failed.has(r.messageId));
        if (toPark.length > 0) {
            try {
                await deps.store.reject(toPark);
                logger.warn("records rejected", { count: toPark.length, firstReason: toPark[0]?.reason });
            } catch (error) {
                logger.error("parking rejected records failed", { error: String(error) });
                for (const r of toPark) failed.add(r.messageId);
            }
        }

        deps.onStats?.({ messages: event.Records.length, inserted, duplicates, rejected: toPark.length, failedMessages: failed.size });
        const batchItemFailures: SQSBatchItemFailure[] = [...failed].map((itemIdentifier) => ({ itemIdentifier }));
        return { batchItemFailures };
    };
}
