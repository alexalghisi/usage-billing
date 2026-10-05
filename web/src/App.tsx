import { useEffect, useState } from "react";
import { api, type Meter } from "./api.ts";
import { Drilldown } from "./components/Drilldown.tsx";
import { EstimatePanel } from "./components/EstimatePanel.tsx";
import { InvoiceDetail } from "./components/InvoiceDetail.tsx";
import { InvoiceList } from "./components/Invoices.tsx";
import { MarketplaceReports } from "./components/MarketplaceReports.tsx";
import { UsageChart } from "./components/UsageChart.tsx";
import { dateTime, METER_LABEL } from "./format.ts";
import { usePoll } from "./usePoll.ts";

const POLL_MS = 1500;
const METERS: Meter[] = ["compute", "storage", "transfer"];

interface Route {
    org?: string;
    invoice?: string;
    line?: string;
}

function readRoute(): Route {
    const [org, invoice, line] = window.location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    return { ...(org ? { org } : {}), ...(invoice ? { invoice } : {}), ...(line ? { line } : {}) };
}

function writeRoute(r: Route): void {
    window.location.hash = `/${[r.org, r.invoice, r.line].filter(Boolean).map((s) => encodeURIComponent(s as string)).join("/")}`;
}

export function App() {
    const [route, setRoute] = useState<Route>(readRoute);
    const [meter, setMeter] = useState<Meter>("compute");
    useEffect(() => {
        const onHash = () => setRoute(readRoute());
        window.addEventListener("hashchange", onHash);
        return () => window.removeEventListener("hashchange", onHash);
    }, []);

    const clock = usePoll((s) => api.clock(s), POLL_MS, []);
    const orgs = usePoll((s) => api.orgs(s), 10_000, []);
    const orgId = route.org ?? orgs.data?.[0]?.id;
    const org = usePoll((s) => (orgId ? api.org(orgId, s) : Promise.resolve(undefined)), POLL_MS * 2, [orgId]);
    const usage = usePoll((s) => (orgId ? api.usage(orgId, "hour", s) : Promise.resolve(undefined)), POLL_MS, [orgId]);
    const estimate = usePoll((s) => (orgId ? api.estimate(orgId, s) : Promise.resolve(undefined)), POLL_MS, [orgId]);
    const marketplace = org.data?.billing.channel === "aws_marketplace";
    const invoices = usePoll((s) => (orgId ? api.invoices(orgId, s) : Promise.resolve([])), POLL_MS * 2, [orgId]);
    const reports = usePoll((s) => (orgId && marketplace ? api.marketplaceReports(orgId, s) : Promise.resolve([])), POLL_MS * 2, [orgId, marketplace]);
    const invoice = usePoll((s) => (route.invoice ? api.invoice(route.invoice, s) : Promise.resolve(undefined)), POLL_MS * 2, [route.invoice]);
    const drill = usePoll((s) => (route.invoice && route.line ? api.drilldown(route.invoice, route.line, s) : Promise.resolve(undefined)), 0, [route.invoice, route.line]);

    const current = orgs.data?.find((o) => o.id === orgId);
    return (
        <div className="app">
            <header className="topbar">
                <div className="brand">
                    Quarry Cloud <span className="muted">Billing</span>
                </div>
                <div className="clock" title="Simulated time">
                    {clock.data ? dateTime(clock.data.now) : "..."}
                </div>
            </header>
            <div className="layout">
                <nav className="sidebar" aria-label="Organizations">
                    {orgs.data?.map((o) => (
                        <button key={o.id} className={o.id === orgId ? "org active" : "org"} onClick={() => writeRoute({ org: o.id })}>
                            <span className="org-name">{o.name}</span>
                            <span className="org-meta">
                                {o.planId} · {o.country}
                                {o.channel === "aws_marketplace" && <span className="tag">AWS Marketplace</span>}
                            </span>
                        </button>
                    ))}
                </nav>
                <main className="main">
                    {current && org.data && (
                        <div className="org-head">
                            <h1>{current.name}</h1>
                            <div className="muted">
                                {current.planId} plan · tax: {org.data.taxProfile.country}
                                {org.data.taxProfile.region ? `-${org.data.taxProfile.region}` : ""}
                                {org.data.taxProfile.vatId ? `, VAT ${org.data.taxProfile.vatId}` : ""}
                                {org.data.contract ? ` · contract, ${org.data.contract.discountBps / 100}% off usage` : ""}
                            </div>
                        </div>
                    )}
                    {estimate.data && org.data && <EstimatePanel estimate={estimate.data} grants={org.data.grants} marketplace={marketplace} />}
                    <section className="panel">
                        <div className="row between">
                            <h3>Usage per hour, last 72 hours</h3>
                            <div className="segmented" role="tablist">
                                {METERS.map((m) => (
                                    <button key={m} role="tab" aria-selected={m === meter} className={m === meter ? "on" : ""} onClick={() => setMeter(m)}>
                                        {METER_LABEL[m]?.name}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {usage.data && <UsageChart points={usage.data.points} from={usage.data.from} to={usage.data.to} meter={meter} />}
                    </section>
                    <div className={marketplace ? "" : "split"}>
                        <section className="panel">
                            <h3>{marketplace ? "Reported to AWS Marketplace" : "Invoices"}</h3>
                            {marketplace ? (
                                <MarketplaceReports reports={reports.data ?? []} />
                            ) : (
                                <InvoiceList invoices={invoices.data ?? []} {...(route.invoice ? { selected: route.invoice } : {})} onSelect={(id) => writeRoute({ ...(orgId ? { org: orgId } : {}), invoice: id })} />
                            )}
                        </section>
                        {invoice.data && (
                            <InvoiceDetail
                                invoice={invoice.data}
                                {...(route.line ? { selectedLine: route.line } : {})}
                                onSelectLine={(line) => writeRoute({ ...(orgId ? { org: orgId } : {}), invoice: invoice.data?._id ?? "", line })}
                            />
                        )}
                    </div>
                    {drill.data && <Drilldown data={drill.data} />}
                    {(estimate.error ?? usage.error) && <p className="error">{estimate.error ?? usage.error}</p>}
                </main>
            </div>
        </div>
    );
}
