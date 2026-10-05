// The API sends money (cents) and quantities (micro-units) as decimal strings.
// They are formatted with BigInt so no amount ever passes through a float.

export function usd(cents: string | bigint): string {
    const v = BigInt(cents);
    const abs = v < 0n ? -v : v;
    const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${v < 0n ? "-" : ""}$${whole}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export function qty(micro: string | bigint, decimals = 2): string {
    const v = BigInt(micro);
    const scale = 10n ** BigInt(6 - decimals);
    const rounded = (v + scale / 2n) / scale;
    const unit = 10n ** BigInt(decimals);
    const whole = (rounded / unit).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return decimals === 0 ? whole : `${whole}.${(rounded % unit).toString().padStart(decimals, "0")}`;
}

/** For chart geometry only; display values always go through qty(). */
export function toNumber(micro: string): number {
    return Number(BigInt(micro) / 1000n) / 1000;
}

export function shortDate(iso: string): string {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function dateTime(iso: string): string {
    return new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

export function monthName(period: string): string {
    const [y, m] = period.split("-").map(Number);
    return new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
}

export const METER_LABEL: Record<string, { name: string; unit: string }> = {
    compute: { name: "Compute", unit: "unit-min" },
    storage: { name: "Storage", unit: "GB-h" },
    transfer: { name: "Data transfer", unit: "GB" },
};

/** Unit price from nano-dollars, with as many decimals as it needs. */
export function unitPrice(nano: string): string {
    const v = BigInt(nano);
    const whole = v / 1_000_000_000n;
    const fraction = (v % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
    return `$${whole}${fraction ? `.${fraction.padEnd(2, "0")}` : ".00"}`;
}
