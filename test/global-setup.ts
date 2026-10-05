import { MongoMemoryReplSet } from "mongodb-memory-server";
import type { TestProject } from "vitest/node";
import { startElasticMq, type ElasticMq } from "../src/infra/elasticmq.ts";

declare module "vitest" {
    export interface ProvidedContext {
        mongoUri: string;
        sqsEndpoint: string;
    }
}

let mongo: MongoMemoryReplSet | undefined;
let sqs: ElasticMq | undefined;

// One single-node replica set (transactions need one) and one ElasticMQ for the
// whole run; every test file works in its own database and its own queues.
export async function setup(project: TestProject): Promise<void> {
    const [m, q] = await Promise.all([
        MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } }),
        startElasticMq({ port: Number(process.env.TEST_SQS_PORT ?? 9346), workDir: ".local/test" }),
    ]);
    mongo = m;
    sqs = q;
    project.provide("mongoUri", m.getUri());
    project.provide("sqsEndpoint", q.endpoint);
}

export async function teardown(): Promise<void> {
    await Promise.all([mongo?.stop(), sqs?.stop()]);
}
