import type { ClientSession } from "mongodb";
import type { Database } from "./mongo.ts";

/**
 * Runs fn in a transaction. The driver retries the whole callback on transient
 * errors such as write conflicts, so fn must not have side effects outside the database.
 */
export async function inTransaction<T>(db: Database, fn: (session: ClientSession) => Promise<T>): Promise<T> {
    return db.client.withSession((session) => session.withTransaction(() => fn(session), { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } }));
}
