import { describe, expect, it } from "vitest";
import { qty, unitPrice, usd } from "./format.ts";

describe("formatting without floats", () => {
    it("formats cents of any size", () => {
        expect(usd("123456789012345678")).toBe("$1,234,567,890,123,456.78");
        expect(usd("-5")).toBe("-$0.05");
    });

    it("rounds micro-unit quantities for display", () => {
        expect(qty("147048489928")).toBe("147,048.49");
        expect(qty("147048495000", 0)).toBe("147,048");
    });

    it("prints unit prices with the precision they have", () => {
        expect(unitPrice("3600000")).toBe("$0.0036");
        expect(unitPrice("90000000")).toBe("$0.09");
        expect(unitPrice("0")).toBe("$0.00");
    });
});
