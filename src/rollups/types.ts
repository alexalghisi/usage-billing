import type { Meter } from "../domain/meters.ts";

export interface HourlyRollup {
    _id: string;
    orgId: string;
    serviceId: string;
    meter: Meter;
    hour: Date;
    /** micro-units */
    quantity: bigint;
    recordCount: number;
    /** Records ingested after the hour closed (hour end + grace). */
    lateRecords: number;
    updatedAt: Date;
}

export interface DailyRollup {
    _id: string;
    orgId: string;
    serviceId: string;
    meter: Meter;
    day: Date;
    quantity: bigint;
    recordCount: number;
    updatedAt: Date;
}

/** Usage is still expected for an hour until this long after it ends. */
export const HOUR_CLOSE_GRACE_MS = 2 * 3_600_000;

export function rollupId(orgId: string, serviceId: string, meter: Meter, bucket: Date): string {
    return `${orgId}|${serviceId}|${meter}|${bucket.toISOString()}`;
}
