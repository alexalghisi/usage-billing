import { useEffect, useRef, useState } from "react";
import type { Meter, UsagePoint } from "../api.ts";
import { dateTime, METER_LABEL, qty, toNumber } from "../format.ts";

interface Props {
    points: UsagePoint[];
    from: string;
    to: string;
    meter: Meter;
}

const HEIGHT = 220;
const PAD = { top: 12, right: 8, bottom: 26, left: 56 };
const HOUR = 3_600_000;

function niceMax(v: number): number {
    if (v <= 0) return 1;
    const exp = 10 ** Math.floor(Math.log10(v));
    const n = v / exp;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * exp;
}

function compact(v: number): string {
    if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k`;
    return `${Math.round(v * 10) / 10}`;
}

/** Hourly usage of one meter as bars. Hours without usage are drawn as gaps, not interpolated. */
export function UsageChart({ points, from, to, meter }: Props) {
    const ref = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(640);
    const [hover, setHover] = useState<number | null>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(280, Math.floor(entry.contentRect.width))));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const start = new Date(from).getTime();
    const hours = Math.max(1, Math.round((new Date(to).getTime() - start) / HOUR));
    const byHour = new Map(points.map((p) => [Math.round((new Date(p.bucket).getTime() - start) / HOUR), p]));
    const values = Array.from({ length: hours }, (_, i) => toNumber(byHour.get(i)?.quantities[meter] ?? "0"));
    const max = niceMax(Math.max(...values));
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const slot = plotW / hours;
    const barW = Math.max(1, slot - 2);
    const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
    const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => f * max);
    const hovered = hover === null ? undefined : byHour.get(hover);

    return (
        <div className="chart" ref={ref}>
            <svg width={width} height={HEIGHT} role="img" aria-label={`${METER_LABEL[meter]?.name} usage per hour`}>
                {ticks.map((t) => (
                    <g key={t}>
                        <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
                        <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" className="tick">
                            {compact(t)}
                        </text>
                    </g>
                ))}
                {values.map((v, i) => {
                    if (v <= 0) return null;
                    const x = PAD.left + i * slot + (slot - barW) / 2;
                    const top = y(v);
                    const h = PAD.top + plotH - top;
                    const r = Math.min(2, barW / 2, h);
                    return (
                        <path
                            key={i}
                            className={hover === i ? "bar active" : "bar"}
                            d={`M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`}
                        />
                    );
                })}
                {Array.from({ length: hours }, (_, i) => i)
                    .filter((i) => new Date(start + i * HOUR).getUTCHours() === 0 && PAD.left + i * slot < width - 48)
                    .map((i) => (
                        <text key={i} x={PAD.left + i * slot} y={HEIGHT - 8} className="tick" textAnchor="start">
                            {new Date(start + i * HOUR).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}
                        </text>
                    ))}
                <line x1={PAD.left} x2={width - PAD.right} y1={PAD.top + plotH} y2={PAD.top + plotH} className="axis" />
                <rect
                    x={PAD.left}
                    y={PAD.top}
                    width={plotW}
                    height={plotH}
                    fill="transparent"
                    onMouseMove={(e) => {
                        const box = e.currentTarget.getBoundingClientRect();
                        setHover(Math.min(hours - 1, Math.max(0, Math.floor((e.clientX - box.left) / slot))));
                    }}
                    onMouseLeave={() => setHover(null)}
                />
            </svg>
            {hover !== null && (
                <div className="tooltip" style={{ left: Math.min(width - 190, PAD.left + hover * slot + 8), top: 8 }}>
                    <div className="muted">{dateTime(new Date(start + hover * HOUR).toISOString())}</div>
                    <strong>
                        {qty(hovered?.quantities[meter] ?? "0")} {METER_LABEL[meter]?.unit}
                    </strong>
                </div>
            )}
        </div>
    );
}
