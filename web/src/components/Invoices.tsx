import type { Invoice } from "../api.ts";
import { monthName, usd } from "../format.ts";

export function StatusPill({ status }: { status: Invoice["status"] }) {
    return <span className={`pill ${status}`}>{status}</span>;
}

export function InvoiceList({ invoices, selected, onSelect }: { invoices: Invoice[]; selected?: string; onSelect: (id: string) => void }) {
    if (invoices.length === 0) return <p className="muted">No invoices yet.</p>;
    return (
        <table className="table invoices">
            <thead>
                <tr>
                    <th>Period</th>
                    <th>Number</th>
                    <th>Status</th>
                    <th className="num">Total</th>
                </tr>
            </thead>
            <tbody>
                {invoices.map((inv) => (
                    <tr key={inv._id} className={inv._id === selected ? "selected" : ""} onClick={() => onSelect(inv._id)} tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onSelect(inv._id)}>
                        <td className="nowrap">{monthName(inv.period)}</td>
                        <td className="mono nowrap">{inv.number ?? <span className="muted">draft</span>}</td>
                        <td>
                            <StatusPill status={inv.status} />
                        </td>
                        <td className="num">{usd(inv.total)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
