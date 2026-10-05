import type { MarketplaceReport } from "../api.ts";
import { dateTime } from "../format.ts";

export function MarketplaceReports({ reports }: { reports: MarketplaceReport[] }) {
    if (reports.length === 0) return <p className="muted">Nothing reported yet. Usage is reported once an hour has closed.</p>;
    return (
        <div className="scroll">
            <table className="table">
                <thead>
                    <tr>
                        <th>Hour</th>
                        <th>Dimension</th>
                        <th className="num">Units</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    {reports.slice(0, 60).map((r) => (
                        <tr key={r._id}>
                            <td className="nowrap">{dateTime(r.hour)}</td>
                            <td className="mono">{r.dimension}</td>
                            <td className="num">{r.quantity.toLocaleString("en-US")}</td>
                            <td>
                                <span className={`pill ${r.status}`}>{r.status}</span>
                                {r.duplicate && <span className="muted small"> after a retry, deduplicated by AWS</span>}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
