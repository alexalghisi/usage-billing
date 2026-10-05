import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import { connectDatabase, type Database } from "../../src/infra/mongo.ts";
import { createSqsClient, ensureQueue, type QueuePair } from "../../src/infra/sqs.ts";
import type { SQSClient } from "@aws-sdk/client-sqs";

export function uniqueName(prefix: string): string {
    return `${prefix}_${randomBytes(4).toString("hex")}`;
}

export async function testDatabase(prefix = "test"): Promise<Database> {
    return connectDatabase(inject("mongoUri"), uniqueName(`ub_${prefix}`));
}

export async function testQueue(prefix = "usage", maxReceiveCount = 3): Promise<{ sqs: SQSClient } & QueuePair> {
    const sqs = createSqsClient(inject("sqsEndpoint"));
    const pair = await ensureQueue(sqs, uniqueName(prefix), maxReceiveCount, 30);
    return { sqs, ...pair };
}
