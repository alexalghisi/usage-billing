import { divRound, EXACT_PER_CENT, formatFixed, parseFixed, type RoundingMode } from "./fixed.ts";

/** Integer US cents. */
export type Cents = bigint;

export function cents(text: string): Cents {
    return parseFixed(text, 2);
}

export function formatUsd(value: Cents): string {
    const abs = value < 0n ? -value : value;
    const [whole = "0", fraction = "00"] = formatFixed(abs, 2, 2).split(".");
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return `${value < 0n ? "-" : ""}$${grouped}.${fraction}`;
}

/** Round an exact (qty-scale x price-scale) amount to cents. */
export function exactToCents(exact: bigint, mode: RoundingMode = "half-even"): Cents {
    return divRound(exact, EXACT_PER_CENT, mode);
}
