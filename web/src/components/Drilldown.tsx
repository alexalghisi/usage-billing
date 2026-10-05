import type { Drilldown as DrilldownData, Meter } from "../api.ts";
import { dateTime, METER_LABEL, monthName, qty, unitPrice, usd } from "../format.ts";

const METERS: Meter[] = ["compute", "storage", "transfer"];

export function Drilldown({ data }: { data: DrilldownData }) {
    if (data.adjustment) {
        const a = data.adjustment;
        return (
            <section className="panel drilldown">
                <h3>Why this adjustment</h3>
                <p className="muted">
                    Usage for {monthName(a.period)} arrived after that invoice was finalized. The period was re-rated with the late usage and the difference is billed here.
                </p>
                <table className="table">
                    <thead>
                        <tr>
                            <th>Meter</th>
                            <th className="num">Invoiced</th>
                            <th className="num">Now</th>
                        </tr>
                    </thead>
                    <tbody>
                        {METERS.filter((m) => a.usage[m] !== a.previousUsage[m]).map((m) => (
                            <tr key={m}>
                                <td>{METER_LABEL[m]?.name}</td>
                                <td className="num">{qty(a.previousUsage[m])}</td>
                                <td className="num">{qty(a.usage[m])}</td>
                            </tr>
                        ))}
                        <tr className="total">
                            <td>Net charge for the period</td>
                            <td className="num">{usd(a.previousNet)}</td>
                            <td className="num">{usd(a.net)}</td>
                        </tr>
                    </tbody>
                </table>
            </section>
        );
    }
    const rollups = data.rollups ?? [];
    const unit = data.line.meter ? METER_LABEL[data.line.meter]?.unit : "";
    return (
        <section className="panel drilldown">
            <h3>Usage behind “{data.line.description.split(":")[0]}”</h3>
            <div className="meters">
                <div>
                    <div className="label">Billed</div>
                    <div className="value">
                        {qty(data.billedQuantity ?? "0")} <span className="muted">{unit}</span>
                    </div>
                </div>
                <div>
                    <div className="label">Sum of rollups now</div>
                    <div className="value">
                        {qty(data.currentQuantity ?? "0")} <span className="muted">{unit}</span>
                    </div>
                </div>
                <div>
                    <div className="label">Hourly rollups</div>
                    <div className="value">{rollups.length}</div>
                </div>
            </div>
            <p className={data.changedSinceInvoiced && data.invoiceStatus !== "draft" ? "note warn" : "note"}>
                {!data.changedSinceInvoiced
                    ? "The rollups add up to exactly the billed quantity."
                    : data.invoiceStatus === "draft"
                      ? "Usage has arrived since this draft was last refreshed; drafts follow the rollups until they are finalized."
                      : "Usage changed after this invoice was finalized; the difference is billed as an adjustment on a later invoice."}
                {data.lateRecords ? ` ${data.lateRecords} record(s) arrived after their hour closed.` : ""}
            </p>
            {data.line.tiers && data.line.tiers.length > 0 && (
                <table className="table tiers">
                    <thead>
                        <tr>
                            <th>Price band</th>
                            <th className="num">Quantity</th>
                            <th className="num">Unit price</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.line.tiers.map((t) => (
                            <tr key={t.from}>
                                <td>
                                    {qty(t.from, 0)} to {t.to === null ? "unlimited" : qty(t.to, 0)}
                                </td>
                                <td className="num">{qty(t.quantity)}</td>
                                <td className="num mono">{unitPrice(t.unitPrice)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <div className="scroll">
                <table className="table rollups">
                    <thead>
                        <tr>
                            <th>Hour</th>
                            <th>Service</th>
                            <th className="num">Records</th>
                            <th className="num">Quantity</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rollups.slice(-200).reverse().map((r) => (
                            <tr key={`${r.hour}-${r.serviceId}`}>
                                <td className="nowrap">{dateTime(r.hour)}</td>
                                <td className="mono">{r.serviceId}</td>
                                <td className="num">
                                    {r.recordCount}
                                    {r.lateRecords > 0 && <span className="late"> {r.lateRecords} late</span>}
                                </td>
                                <td className="num">{qty(r.quantity)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>
    );
}
