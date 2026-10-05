import { HOUR_MS, type Period } from "../domain/time.ts";

export interface PlanChange {
    planId: string;
    /** Hour-aligned; billing works on hourly rollups. */
    effectiveFrom: Date;
}

export interface Segment {
    planId: string;
    from: Date;
    to: Date;
}

/**
 * Splits a period at plan changes. Time before the first plan (an org that
 * signed up mid-period) is not billed at all.
 */
export function planSegments(history: readonly PlanChange[], period: Period): Segment[] {
    const sorted = [...history].sort((a, b) => a.effectiveFrom.getTime() - b.effectiveFrom.getTime());
    for (const change of sorted) {
        if (change.effectiveFrom.getTime() % HOUR_MS !== 0) throw new Error(`plan change at ${change.effectiveFrom.toISOString()} is not hour-aligned`);
    }
    const segments: Segment[] = [];
    sorted.forEach((change, i) => {
        const next = sorted[i + 1];
        const from = new Date(Math.max(change.effectiveFrom.getTime(), period.start.getTime()));
        const to = new Date(Math.min(next ? next.effectiveFrom.getTime() : Infinity, period.end.getTime()));
        if (from < to) segments.push({ planId: change.planId, from, to });
    });
    // Two consecutive changes to the same plan are one segment.
    return segments.reduce<Segment[]>((acc, s) => {
        const prev = acc[acc.length - 1];
        if (prev && prev.planId === s.planId && prev.to.getTime() === s.from.getTime()) prev.to = s.to;
        else acc.push({ ...s });
        return acc;
    }, []);
}
