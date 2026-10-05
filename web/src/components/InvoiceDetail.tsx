import type { Invoice, InvoiceLine } from "../api.ts";
import { monthName, usd } from "../format.ts";
import { StatusPill } from "./Invoices.tsx";

function drillable(line: InvoiceLine): boolean {
    return line.kind === "adjustment" || (line.kind === "usage" && BigInt(line.quantity ?? "0") > 0n);
}

export function InvoiceDetail({ invoice, selectedLine, onSelectLine }: { invoice: Invoice; selectedLine?: string; onSelectLine: (id: string) => void }) {
    return (
        <section className="panel">
            <div className="row between">
                <h3>
                    {invoice.number ?? "Draft invoice"} <span className="muted">· {monthName(invoice.period)}</span>
                </h3>
                <div className="row gap">
                    {invoice.verified !== undefined && invoice.status !== "draft" && (
                        <span className={`badge ${invoice.verified ? "ok" : "bad"}`} title="Content hash recomputed and compared">
                            {invoice.verified ? "hash verified" : "hash mismatch"}
                        </span>
                    )}
                    <StatusPill status={invoice.status} />
                </div>
            </div>
            <table className="table lines">
                <tbody>
                    {invoice.lines.map((line) => (
                        <tr
                            key={line.id}
                            className={`${drillable(line) ? "clickable" : ""} ${line.id === selectedLine ? "selected" : ""} kind-${line.kind}`}
                            onClick={() => drillable(line) && onSelectLine(line.id)}
                        >
                            <td>
                                {line.description}
                                {drillable(line) && <span className="drill">usage</span>}
                            </td>
                            <td className="num">{usd(line.amount)}</td>
                        </tr>
                    ))}
                    <tr className="tax">
                        <td>
                            Tax: {invoice.tax.note}
                        </td>
                        <td className="num">{usd(invoice.tax.amount)}</td>
                    </tr>
                    <tr className="total">
                        <td>Total</td>
                        <td className="num">{usd(invoice.total)}</td>
                    </tr>
                </tbody>
            </table>
        </section>
    );
}
