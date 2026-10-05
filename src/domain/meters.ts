export const METERS = ["compute", "storage", "transfer"] as const;
export type Meter = (typeof METERS)[number];

export const METER_UNITS: Record<Meter, string> = {
    compute: "compute-unit-minutes",
    storage: "GB-hours",
    transfer: "GB egress",
};

export function isMeter(value: string): value is Meter {
    return (METERS as readonly string[]).includes(value);
}

/** Human-readable quantity for descriptions: grouped, two decimals (half-even), trailing ".00" dropped. */
export function formatQuantity(micro: bigint): string {
    const negative = micro < 0n;
    const abs = negative ? -micro : micro;
    let hundredths = abs / 10_000n;
    const rest = abs % 10_000n;
    if (rest > 5_000n || (rest === 5_000n && hundredths % 2n === 1n)) hundredths += 1n;
    const whole = (hundredths / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const fraction = hundredths % 100n;
    return `${negative ? "-" : ""}${whole}${fraction === 0n ? "" : `.${fraction.toString().padStart(2, "0")}`}`;
}

export type MeterQuantities = Record<Meter, bigint>;

export function zeroQuantities(): MeterQuantities {
    return { compute: 0n, storage: 0n, transfer: 0n };
}
