import type { Estimate, Grant, Meter } from "../api.ts";
import { METER_LABEL, monthName, qty, usd } from "../format.ts";

const METERS: Meter[] = ["compute", "storage", "transfer"];

export function EstimatePanel({ estimate, grants, marketplace }: { estimate: Estimate; grants: Grant[]; marketplace: boolean }) {
    const a = estimate.accrued;
    const pct = Math.round((estimate.elapsedHours / estimate.totalHours) * 100);
    const credit = grants.reduce((acc, g) => acc + BigInt(g.remaining), 0n);
    return (
        <section className="panel estimate">
            <div className="estimate-head">
                <div>
                    <div className="label">{marketplace ? "Usage at list price" : "Running bill"}, {monthName(estimate.period)}</div>
                    <div className="hero" data-testid="accrued">{usd(a.total)}</div>
                    <div className="muted">
                        {marketplace
                            ? "so far; AWS Marketplace bills it from the hourly usage reports"
                            : `so far, including ${a.tax.rateBps > 0 ? `${a.tax.rateBps / 100}% tax` : "no tax"}${BigInt(a.credits) > 0n ? ` and ${usd(a.credits)} of credits` : ""}`}
                    </div>
                </div>
                <div>
                    <div className="label">Projected for the month</div>
                    <div className="hero secondary">{usd(estimate.projectedTotal)}</div>
                    <div className="muted">at the current rate</div>
                </div>
                <div>
                    <div className="label">Credit balance</div>
                    <div className="hero secondary">{usd(credit)}</div>
                    <div className="muted">{grants.filter((g) => BigInt(g.remaining) > 0n).map((g) => g.description).join(", ") || "none"}</div>
                </div>
            </div>
            <div className="progress" aria-label={`${pct}% of the period elapsed`}>
                <div style={{ width: `${pct}%` }} />
            </div>
            <div className="muted small">
                {estimate.elapsedHours} of {estimate.totalHours} hours of the period metered
            </div>
            <div className="meters">
                {METERS.map((m) => (
                    <div key={m}>
                        <div className="label">{METER_LABEL[m]?.name}</div>
                        <div className="value">
                            {qty(a.usage[m], 0)} <span className="muted">{METER_LABEL[m]?.unit}</span>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
