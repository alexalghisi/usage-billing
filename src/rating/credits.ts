import type { Period } from "../domain/time.ts";
import type { Cents } from "../money/money.ts";

export type GrantKind = "trial" | "prepaid" | "balance";

export interface CreditGrant {
    _id: string;
    orgId: string;
    kind: GrantKind;
    description: string;
    amount: Cents;
    remaining: Cents;
    effectiveAt: Date;
    expiresAt: Date | null;
    createdAt: Date;
}

export interface CreditApplication {
    grantId: string;
    kind: GrantKind;
    description: string;
    amount: Cents;
}

const KIND_ORDER: Record<GrantKind, number> = { trial: 0, prepaid: 1, balance: 2 };

/** A grant counts for a period's invoice if it was valid at any point during the period. */
export function isEligible(grant: CreditGrant, period: Period): boolean {
    return grant.remaining > 0n && grant.effectiveAt < period.end && (grant.expiresAt === null || grant.expiresAt > period.start);
}

/**
 * Burns credits against an amount due: soonest-expiring first, then free
 * (trial) before paid (prepaid commitment) before refund balances, then oldest.
 * Using the credit that would otherwise lapse first is what customers expect.
 */
export function applyCredits(amountDue: Cents, grants: readonly CreditGrant[], period: Period): { applied: CreditApplication[]; remainingDue: Cents } {
    const usable = grants
        .filter((g) => isEligible(g, period))
        .sort(
            (a, b) =>
                (a.expiresAt?.getTime() ?? Infinity) - (b.expiresAt?.getTime() ?? Infinity) ||
                KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
                a.createdAt.getTime() - b.createdAt.getTime() ||
                a._id.localeCompare(b._id),
        );
    let due = amountDue > 0n ? amountDue : 0n;
    const applied: CreditApplication[] = [];
    for (const grant of usable) {
        if (due === 0n) break;
        const amount = grant.remaining < due ? grant.remaining : due;
        applied.push({ grantId: grant._id, kind: grant.kind, description: grant.description, amount });
        due -= amount;
    }
    return { applied, remainingDue: amountDue > 0n ? due : amountDue };
}
