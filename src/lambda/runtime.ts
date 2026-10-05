import { createServices, type Services } from "../app/context.ts";
import { systemClock } from "../domain/time.ts";
import { jsonLogger } from "../infra/logger.ts";
import { connectDatabase } from "../infra/mongo.ts";

let services: Promise<Services> | undefined;

/** One MongoDB connection per Lambda execution environment, reused across invocations. */
export function getServices(): Promise<Services> {
    const uri = process.env.MONGO_URL;
    if (!uri) throw new Error("MONGO_URL is not set");
    services ??= connectDatabase(uri, process.env.MONGO_DB ?? "billing").then((db) => createServices(db, systemClock));
    return services;
}

export const logger = jsonLogger;
