// Exact fixed-point arithmetic on bigint. No floating point is used anywhere in
// metering, rating or invoicing.
//
// Scales:
//   quantities   micro-units  (1e-6 of a meter unit)
//   unit prices  nano-dollars (1e-9 USD per meter unit)
//   amounts      cents        (1e-2 USD), after one rounding step per line
// quantity * unit price is exact in 1e-15 USD; dividing by 1e13 gives cents.

export const QTY_DECIMALS = 6;
export const PRICE_DECIMALS = 9;
export const QTY_SCALE = 10n ** BigInt(QTY_DECIMALS);
export const PRICE_SCALE = 10n ** BigInt(PRICE_DECIMALS);
/** exact amount units (qty scale * price scale) per cent */
export const EXACT_PER_CENT = (QTY_SCALE * PRICE_SCALE) / 100n;

export type RoundingMode = "half-even" | "half-up";

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

export function parseFixed(text: string, decimals: number): bigint {
    const match = DECIMAL.exec(text.trim());
    if (!match) throw new RangeError(`not a decimal number: ${JSON.stringify(text)}`);
    const [, sign, whole = "0", fraction = ""] = match;
    if (fraction.length > decimals) throw new RangeError(`more than ${decimals} decimal places: ${text}`);
    const value = BigInt(whole + fraction.padEnd(decimals, "0"));
    return sign ? -value : value;
}

export function formatFixed(value: bigint, decimals: number, minDecimals = 0): string {
    const negative = value < 0n;
    const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
    const whole = digits.slice(0, digits.length - decimals);
    let fraction = decimals > 0 ? digits.slice(digits.length - decimals) : "";
    while (fraction.length > minDecimals && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
    return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/** Integer division of n by d (d > 0) with the given rounding of the remainder. */
export function divRound(n: bigint, d: bigint, mode: RoundingMode): bigint {
    if (d <= 0n) throw new RangeError("divisor must be positive");
    const negative = n < 0n;
    const abs = negative ? -n : n;
    const q = abs / d;
    const r = abs % d;
    const twice = r * 2n;
    let rounded = q;
    if (twice > d) rounded = q + 1n;
    else if (twice === d) rounded = mode === "half-up" || q % 2n === 1n ? q + 1n : q;
    return negative ? -rounded : rounded;
}

/** floor(n * num / den) for non-negative n, num and positive den. */
export function mulDivFloor(n: bigint, num: bigint, den: bigint): bigint {
    if (n < 0n || num < 0n || den <= 0n) throw new RangeError("mulDivFloor expects non-negative operands");
    return (n * num) / den;
}

export function bigMin(a: bigint, b: bigint): bigint {
    return a < b ? a : b;
}

export function bigMax(a: bigint, b: bigint): bigint {
    return a > b ? a : b;
}

export function sum(values: Iterable<bigint>): bigint {
    let total = 0n;
    for (const v of values) total += v;
    return total;
}
