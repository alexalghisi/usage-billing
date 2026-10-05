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

export type MeterQuantities = Record<Meter, bigint>;

export function zeroQuantities(): MeterQuantities {
    return { compute: 0n, storage: 0n, transfer: 0n };
}
