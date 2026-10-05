import { randomUUID } from "node:crypto";
import type { ClientSession } from "mongodb";
import type { AuditLog } from "../audit/audit-log.ts";
import { addHours, DAY_MS, startOfHour, type Clock } from "../domain/time.ts";
import type { Database } from "../infra/mongo.ts";
import { inTransaction } from "../infra/tx.ts";
import type { Cents } from "../money/money.ts";
import type { CreditGrant, GrantKind } from "../rating/credits.ts";
import type { PlanCatalog } from "../rating/plan.ts";
import type { Contract, Org } from "./org.ts";

export interface NewOrg extends Omit<Org, "createdAt" | "plans" | "contract"> {
    planId: string;
    /** Defaults to the creation time rounded down to the hour. */
    startsAt?: Date;
    trialCredit?: { amount: Cents; days: number };
}

export interface GrantInput {
    orgId: string;
    kind: GrantKind;
    amount: Cents;
    description: string;
    effectiveAt: Date;
    expiresAt: Date | null;
}

/** Org lifecycle changes that affect money: plans, contracts, credits. All of them are audited. */
export class OrgService {
    private readonly db: Database;
    private readonly audit: AuditLog;
    private readonly clock: Clock;
    private readonly catalog: PlanCatalog;

    constructor(deps: { db: Database; audit: AuditLog; clock: Clock; catalog: PlanCatalog }) {
        this.db = deps.db;
        this.audit = deps.audit;
        this.clock = deps.clock;
        this.catalog = deps.catalog;
    }

    async create(input: NewOrg, actor = "system"): Promise<Org> {
        this.catalog.get(input.planId);
        const startsAt = startOfHour(input.startsAt ?? this.clock.now());
        const org: Org = {
            _id: input._id,
            name: input.name,
            createdAt: this.clock.now(),
            billing: input.billing,
            taxProfile: input.taxProfile,
            plans: [{ planId: input.planId, effectiveFrom: startsAt }],
            contract: null,
        };
        await inTransaction(this.db, async (session) => {
            await this.db.orgs.insertOne(org, { session });
            await this.audit.append(session, { actor, action: "org.created", entityType: "org", entityId: org._id, orgId: org._id, data: { planId: input.planId, billing: input.billing.channel } });
            if (input.trialCredit) {
                await this.grant(session, actor, {
                    orgId: org._id,
                    kind: "trial",
                    amount: input.trialCredit.amount,
                    description: "Free trial credit",
                    effectiveAt: startsAt,
                    expiresAt: new Date(startsAt.getTime() + input.trialCredit.days * DAY_MS),
                });
            }
        });
        return org;
    }

    async get(orgId: string): Promise<Org> {
        const org = await this.db.orgs.findOne({ _id: orgId });
        if (!org) throw new NotFoundError(`org ${orgId}`);
        return org;
    }

    list(): Promise<Org[]> {
        return this.db.orgs.find({}).sort({ _id: 1 }).toArray();
    }

    /** Plan changes take effect at the start of the next hour unless a later hour is given. */
    async changePlan(orgId: string, planId: string, actor: string, effectiveFrom?: Date): Promise<Org> {
        this.catalog.get(planId);
        const earliest = addHours(startOfHour(this.clock.now()), 1);
        const at = effectiveFrom ? startOfHour(effectiveFrom) : earliest;
        if (at < earliest) throw new Error("plan changes cannot be backdated");
        await inTransaction(this.db, async (session) => {
            const res = await this.db.orgs.updateOne({ _id: orgId }, { $push: { plans: { planId, effectiveFrom: at } } }, { session });
            if (res.matchedCount === 0) throw new NotFoundError(`org ${orgId}`);
            await this.audit.append(session, { actor, action: "plan.changed", entityType: "org", entityId: orgId, orgId, data: { planId, effectiveFrom: at } });
        });
        return this.get(orgId);
    }

    /** A committed-spend contract: the commitment is prepaid and granted as credits that burn down over the term. */
    async signContract(orgId: string, contract: Contract, actor: string): Promise<void> {
        await inTransaction(this.db, async (session) => {
            const res = await this.db.orgs.updateOne({ _id: orgId }, { $set: { contract } }, { session });
            if (res.matchedCount === 0) throw new NotFoundError(`org ${orgId}`);
            await this.audit.append(session, { actor, action: "contract.signed", entityType: "org", entityId: orgId, orgId, amount: contract.commitment, data: { ...contract } });
            if (contract.commitment > 0n) {
                await this.grant(session, actor, {
                    orgId,
                    kind: "prepaid",
                    amount: contract.commitment,
                    description: "Prepaid commitment",
                    effectiveAt: contract.startsAt,
                    expiresAt: contract.endsAt,
                });
            }
        });
    }

    async grantCredit(input: GrantInput, actor: string): Promise<CreditGrant> {
        return inTransaction(this.db, (session) => this.grant(session, actor, input));
    }

    async grant(session: ClientSession, actor: string, input: GrantInput): Promise<CreditGrant> {
        if (input.amount <= 0n) throw new RangeError("credit amount must be positive");
        const grant: CreditGrant = { _id: `cg_${randomUUID().slice(0, 12)}`, ...input, remaining: input.amount, createdAt: this.clock.now() };
        await this.db.creditGrants.insertOne(grant, { session });
        await this.audit.append(session, {
            actor,
            action: "credit.granted",
            entityType: "credit_grant",
            entityId: grant._id,
            orgId: input.orgId,
            amount: input.amount,
            data: { kind: input.kind, expiresAt: input.expiresAt },
        });
        return grant;
    }

    grants(orgId: string): Promise<CreditGrant[]> {
        return this.db.creditGrants.find({ orgId }).sort({ createdAt: 1 }).toArray();
    }
}

export class NotFoundError extends Error {
    constructor(what: string) {
        super(`${what} not found`);
        this.name = "NotFoundError";
    }
}
