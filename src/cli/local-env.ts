import { MongoMemoryReplSet } from "mongodb-memory-server";
import { isSqsReachable, startElasticMq } from "../infra/elasticmq.ts";

export interface LocalEnv {
    mongoUri: string;
    sqsEndpoint: string;
    stop(): Promise<void>;
}

/**
 * MongoDB and SQS for local runs. MONGO_URL / SQS_ENDPOINT point at running
 * servers; otherwise a single-node replica set (mongodb-memory-server) and an
 * ElasticMQ are started and stopped with the process.
 */
export async function startLocalEnv(options: { sqsPort: number }): Promise<LocalEnv> {
    const stops: (() => Promise<unknown>)[] = [];
    let mongoUri = process.env.MONGO_URL;
    if (!mongoUri) {
        const rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
        stops.push(() => rs.stop());
        mongoUri = rs.getUri();
    }
    let sqsEndpoint = process.env.SQS_ENDPOINT;
    if (!sqsEndpoint) {
        const candidate = `http://127.0.0.1:${options.sqsPort}`;
        if (await isSqsReachable(candidate)) sqsEndpoint = candidate;
        else {
            const mq = await startElasticMq({ port: options.sqsPort, workDir: ".local" });
            stops.push(() => mq.stop());
            sqsEndpoint = mq.endpoint;
        }
    }
    return { mongoUri, sqsEndpoint, stop: async () => void (await Promise.all(stops.map((s) => s()))) };
}
