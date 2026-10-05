import {
    ChangeMessageVisibilityBatchCommand,
    DeleteMessageBatchCommand,
    ReceiveMessageCommand,
    type Message,
    type SQSClient,
} from "@aws-sdk/client-sqs";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { silentLogger, type Logger } from "../infra/logger.ts";

export interface PollerOptions {
    sqs: SQSClient;
    queueUrl: string;
    queueArn: string;
    handler: (event: SQSEvent) => Promise<SQSBatchResponse>;
    /** Messages per handler invocation (Lambda BatchSize). */
    batchSize?: number;
    /** How long to keep collecting before invoking with a partial batch (MaximumBatchingWindowInSeconds). */
    batchingWindowMs?: number;
    /** Parallel invocations (Lambda concurrency). */
    concurrency?: number;
    /** Visibility timeout given to failed messages so they come back sooner than the queue default. */
    retryDelaySeconds?: number;
    waitTimeSeconds?: number;
    logger?: Logger;
}

/**
 * Stands in for Lambda's SQS event source mapping when running locally: it
 * receives messages, invokes the handler with a real SQSEvent shape, deletes the
 * messages that succeeded and leaves batch item failures to be redelivered.
 */
export class SqsPoller {
    private running = false;
    private loops: Promise<void>[] = [];
    private readonly opts: Required<Omit<PollerOptions, "logger">> & { logger: Logger };

    constructor(options: PollerOptions) {
        this.opts = {
            batchSize: 100,
            batchingWindowMs: 200,
            concurrency: 2,
            retryDelaySeconds: 2,
            waitTimeSeconds: 1,
            logger: silentLogger,
            ...options,
        };
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.loops = Array.from({ length: this.opts.concurrency }, () => this.loop());
    }

    async stop(): Promise<void> {
        this.running = false;
        await Promise.all(this.loops);
        this.loops = [];
    }

    private async loop(): Promise<void> {
        while (this.running) {
            try {
                const n = await this.pollOnce();
                if (n === 0) await new Promise((r) => setTimeout(r, 50));
            } catch (error) {
                this.opts.logger.error("poll failed", { error: String(error) });
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
    }

    /** Receives up to one batch and processes it. Returns the number of messages received. */
    async pollOnce(): Promise<number> {
        const messages = await this.collectBatch();
        if (messages.length === 0) return 0;
        const event: SQSEvent = { Records: messages.map((m) => this.toRecord(m)) };
        let failedIds: Set<string>;
        try {
            const response = await this.opts.handler(event);
            failedIds = new Set(response.batchItemFailures.map((f) => f.itemIdentifier));
        } catch (error) {
            this.opts.logger.error("handler threw; whole batch will be retried", { error: String(error) });
            failedIds = new Set(messages.map((m) => m.MessageId ?? ""));
        }
        const succeeded = messages.filter((m) => !failedIds.has(m.MessageId ?? ""));
        const failed = messages.filter((m) => failedIds.has(m.MessageId ?? ""));
        await this.deleteAll(succeeded);
        await this.delayRetry(failed);
        return messages.length;
    }

    private async collectBatch(): Promise<Message[]> {
        const batch: Message[] = [];
        const deadline = Date.now() + this.opts.batchingWindowMs;
        while (batch.length < this.opts.batchSize) {
            const res = await this.opts.sqs.send(
                new ReceiveMessageCommand({
                    QueueUrl: this.opts.queueUrl,
                    MaxNumberOfMessages: Math.min(10, this.opts.batchSize - batch.length),
                    WaitTimeSeconds: batch.length === 0 ? this.opts.waitTimeSeconds : 0,
                    MessageSystemAttributeNames: ["All"],
                    MessageAttributeNames: ["All"],
                }),
            );
            const received = res.Messages ?? [];
            batch.push(...received);
            if (received.length === 0 || Date.now() >= deadline || !this.running) break;
        }
        return batch;
    }

    private toRecord(m: Message): SQSRecord {
        const attrs = m.Attributes ?? {};
        return {
            messageId: m.MessageId ?? "",
            receiptHandle: m.ReceiptHandle ?? "",
            body: m.Body ?? "",
            attributes: {
                ApproximateReceiveCount: attrs.ApproximateReceiveCount ?? "1",
                SentTimestamp: attrs.SentTimestamp ?? String(Date.now()),
                SenderId: attrs.SenderId ?? "local",
                ApproximateFirstReceiveTimestamp: attrs.ApproximateFirstReceiveTimestamp ?? String(Date.now()),
            },
            messageAttributes: {},
            md5OfBody: m.MD5OfBody ?? "",
            eventSource: "aws:sqs",
            eventSourceARN: this.opts.queueArn,
            awsRegion: "eu-west-1",
        };
    }

    private async deleteAll(messages: Message[]): Promise<void> {
        for (let i = 0; i < messages.length; i += 10) {
            const chunk = messages.slice(i, i + 10);
            await this.opts.sqs.send(
                new DeleteMessageBatchCommand({
                    QueueUrl: this.opts.queueUrl,
                    Entries: chunk.map((m, j) => ({ Id: String(j), ReceiptHandle: m.ReceiptHandle ?? "" })),
                }),
            );
        }
    }

    private async delayRetry(messages: Message[]): Promise<void> {
        for (let i = 0; i < messages.length; i += 10) {
            const chunk = messages.slice(i, i + 10);
            await this.opts.sqs.send(
                new ChangeMessageVisibilityBatchCommand({
                    QueueUrl: this.opts.queueUrl,
                    Entries: chunk.map((m, j) => ({ Id: String(j), ReceiptHandle: m.ReceiptHandle ?? "", VisibilityTimeout: this.opts.retryDelaySeconds })),
                }),
            );
        }
    }
}
