import { SendMessageBatchCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { UsageRecordInput } from "./record.ts";

/**
 * What a service-side metering agent does: pack records into envelopes and send
 * them in SQS batches of ten messages. Entries the queue refuses are resent.
 */
export class UsagePublisher {
    private readonly sqs: SQSClient;
    private readonly queueUrl: string;
    private readonly recordsPerMessage: number;
    constructor(sqs: SQSClient, queueUrl: string, recordsPerMessage = 50) {
        this.sqs = sqs;
        this.queueUrl = queueUrl;
        this.recordsPerMessage = recordsPerMessage;
    }

    async publish(records: readonly UsageRecordInput[]): Promise<number> {
        const bodies: string[] = [];
        for (let i = 0; i < records.length; i += this.recordsPerMessage) {
            bodies.push(JSON.stringify({ records: records.slice(i, i + this.recordsPerMessage) }));
        }
        await this.sendBodies(bodies);
        return bodies.length;
    }

    async sendBodies(bodies: readonly string[]): Promise<void> {
        for (let i = 0; i < bodies.length; i += 10) {
            let entries = bodies.slice(i, i + 10).map((body, j) => ({ Id: String(j), MessageBody: body }));
            for (let attempt = 0; entries.length > 0; attempt++) {
                if (attempt === 5) throw new Error(`SendMessageBatch kept failing for ${entries.length} entries`);
                const res = await this.sqs.send(new SendMessageBatchCommand({ QueueUrl: this.queueUrl, Entries: entries }));
                const failed = new Set((res.Failed ?? []).map((f) => f.Id));
                entries = entries.filter((e) => failed.has(e.Id));
                if (entries.length > 0) await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
            }
        }
    }
}
