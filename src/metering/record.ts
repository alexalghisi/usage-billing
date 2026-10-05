import { createHash } from "node:crypto";
import { z } from "zod";
import { METERS, type Meter } from "../domain/meters.ts";
import { startOfHour, type Clock } from "../domain/time.ts";
import { parseFixed, QTY_DECIMALS } from "../money/fixed.ts";

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Largest quantity a single record may carry (one billion meter units). */
const MAX_QUANTITY = 1_000_000_000n * 10n ** BigInt(QTY_DECIMALS);
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
const MAX_AGE_MS = 400 * 24 * 3_600_000;

// Quantities travel as decimal strings so that no producer ever has to put a
// billable number through a float.
const usageRecordInput = z.object({
    eventId: z.string().min(1).max(128),
    orgId: z.string().regex(ID),
    serviceId: z.string().regex(ID),
    meter: z.enum(METERS),
    quantity: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/, "quantity must be a non-negative decimal string with at most 6 decimals"),
    timestamp: z.iso.datetime({ offset: false }),
});

export const usageEnvelope = z.object({
    records: z.array(z.unknown()).min(1).max(1000),
});

export type UsageRecordInput = z.infer<typeof usageRecordInput>;

export interface UsageRecord {
    _id: string;
    eventId: string;
    orgId: string;
    serviceId: string;
    meter: Meter;
    /** micro-units */
    quantity: bigint;
    timestamp: Date;
    hour: Date;
    payloadHash: string;
    ingestedAt: Date;
}

export type ValidationResult = { ok: true; record: UsageRecord } | { ok: false; reason: string };

/**
 * The id is derived from who emitted the event and the producer's own event id,
 * so a redelivered or re-sent record always lands on the same document.
 */
export function recordId(input: Pick<UsageRecordInput, "orgId" | "serviceId" | "meter" | "eventId">): string {
    return createHash("sha256")
        .update([input.orgId, input.serviceId, input.meter, input.eventId].join("\u0000"))
        .digest("hex")
        .slice(0, 40);
}

function payloadHash(quantity: bigint, timestamp: Date): string {
    return createHash("sha256").update(`${quantity}|${timestamp.getTime()}`).digest("hex").slice(0, 16);
}

export function validateRecord(raw: unknown, clock: Clock): ValidationResult {
    const parsed = usageRecordInput.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, reason: issue ? `${issue.path.join(".") || "record"}: ${issue.message}` : "invalid record" };
    }
    const input = parsed.data;
    const quantity = parseFixed(input.quantity, QTY_DECIMALS);
    if (quantity > MAX_QUANTITY) return { ok: false, reason: "quantity: exceeds per-record maximum" };
    const timestamp = new Date(input.timestamp);
    const now = clock.now().getTime();
    if (timestamp.getTime() > now + MAX_FUTURE_SKEW_MS) return { ok: false, reason: "timestamp: in the future" };
    if (timestamp.getTime() < now - MAX_AGE_MS) return { ok: false, reason: "timestamp: older than retention window" };
    return {
        ok: true,
        record: {
            _id: recordId(input),
            eventId: input.eventId,
            orgId: input.orgId,
            serviceId: input.serviceId,
            meter: input.meter,
            quantity,
            timestamp,
            hour: startOfHour(timestamp),
            payloadHash: payloadHash(quantity, timestamp),
            ingestedAt: clock.now(),
        },
    };
}
