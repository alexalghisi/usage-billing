import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { divRound, formatFixed, mulDivFloor, parseFixed } from "../../src/money/fixed.ts";
import { exactToCents, formatUsd } from "../../src/money/money.ts";

describe("parseFixed / formatFixed", () => {
    it("parses decimal strings exactly", () => {
        expect(parseFixed("12.5", 6)).toBe(12_500_000n);
        expect(parseFixed("0.000001", 6)).toBe(1n);
        expect(parseFixed("-3.07", 2)).toBe(-307n);
        expect(parseFixed("42", 0)).toBe(42n);
    });

    it("refuses extra precision instead of silently rounding it away", () => {
        expect(() => parseFixed("0.0000001", 6)).toThrow(/decimal places/);
        expect(() => parseFixed("1e3", 6)).toThrow(/not a decimal/);
        expect(() => parseFixed("", 6)).toThrow();
    });

    it("formats with trimmed or minimum decimals", () => {
        expect(formatFixed(12_500_000n, 6)).toBe("12.5");
        expect(formatFixed(1n, 6)).toBe("0.000001");
        expect(formatFixed(-307n, 2, 2)).toBe("-3.07");
        expect(formatFixed(500n, 2, 2)).toBe("5.00");
    });

    it("round-trips any value", () => {
        fc.assert(
            fc.property(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), fc.integer({ min: 0, max: 12 }), (v, d) => {
                expect(parseFixed(formatFixed(v, d), d)).toBe(v);
            }),
        );
    });
});

describe("divRound", () => {
    it("rounds half to even", () => {
        expect(divRound(5n, 2n, "half-even")).toBe(2n);
        expect(divRound(7n, 2n, "half-even")).toBe(4n);
        expect(divRound(-5n, 2n, "half-even")).toBe(-2n);
        expect(divRound(26n, 10n, "half-even")).toBe(3n);
    });

    it("rounds half away from zero in half-up mode", () => {
        expect(divRound(5n, 2n, "half-up")).toBe(3n);
        expect(divRound(-5n, 2n, "half-up")).toBe(-3n);
        expect(divRound(24n, 10n, "half-up")).toBe(2n);
    });

    it("never moves more than half a unit away from the exact quotient", () => {
        fc.assert(
            fc.property(fc.bigInt({ min: -(10n ** 24n), max: 10n ** 24n }), fc.bigInt({ min: 1n, max: 10n ** 15n }), fc.constantFrom("half-even" as const, "half-up" as const), (n, d, mode) => {
                const q = divRound(n, d, mode);
                const error = q * d - n; // scaled by d
                expect(2n * (error < 0n ? -error : error) <= d).toBe(true);
            }),
        );
    });

    it("is symmetric around zero", () => {
        fc.assert(
            fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), fc.bigInt({ min: 1n, max: 10n ** 9n }), (n, d) => {
                expect(divRound(-n, d, "half-even")).toBe(-divRound(n, d, "half-even"));
            }),
        );
    });

    it("half-even has no systematic bias over exact halves", () => {
        let drift = 0n;
        for (let i = 0n; i < 1000n; i++) drift += divRound(2n * i + 1n, 2n, "half-even") * 2n - (2n * i + 1n);
        expect(drift).toBe(0n);
    });
});

describe("money helpers", () => {
    it("converts exact amounts to cents", () => {
        // 1,000,000.5 unit-minutes at $0.0035 = $3500.00175 -> 350000 cents
        const exact = parseFixed("1000000.5", 6) * parseFixed("0.0035", 9);
        expect(exactToCents(exact)).toBe(350_000n);
    });

    it("formats USD with grouping", () => {
        expect(formatUsd(123_456_789n)).toBe("$1,234,567.89");
        expect(formatUsd(-5n)).toBe("-$0.05");
    });

    it("mulDivFloor floors", () => {
        expect(mulDivFloor(10n, 1n, 3n)).toBe(3n);
    });
});
