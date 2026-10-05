import { describe, expect, it } from "vitest";
import { formatQuantity } from "../../src/domain/meters.ts";

describe("formatQuantity", () => {
    it.each([
        [250_000_000_000n, "250,000"],
        [147_048_489_928n, "147,048.49"],
        [1_005_000n, "1"], // 1.005 -> 1.00 (half to even)
        [1_015_000n, "1.02"],
        [-4_452_000_000n, "-4,452"],
        [0n, "0"],
    ])("%s micro-units -> %s", (micro, text) => {
        expect(formatQuantity(micro)).toBe(text);
    });
});
