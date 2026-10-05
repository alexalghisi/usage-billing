import { divRound, formatFixed } from "../money/fixed.ts";
import type { Cents } from "../money/money.ts";
import type { TaxProvider, TaxQuote, TaxRequest } from "./tax.ts";

// Standard VAT rates for electronically supplied services, basis points.
const EU_VAT_BPS: Record<string, number> = {
    AT: 2000, BE: 2100, DE: 1900, DK: 2500, ES: 2100, FI: 2550, FR: 2000, GR: 2400, IE: 2300,
    IT: 2200, LU: 1700, NL: 2100, PL: 2300, PT: 2300, RO: 2100, SE: 2500,
};

// Illustrative state rates for SaaS; most states do not tax it at all.
const US_SALES_TAX_BPS: Record<string, number> = { NY: 400, PA: 600, TX: 625, WA: 650 };

/** Greece uses EL as its VAT prefix. */
const VAT_PREFIX: Record<string, string> = { GR: "EL" };

export function isPlausibleVatId(country: string, vatId: string): boolean {
    const prefix = VAT_PREFIX[country] ?? country;
    return new RegExp(`^${prefix}[A-Z0-9]{2,12}$`).test(vatId.replace(/[\s.-]/g, "").toUpperCase());
}

/**
 * Rules for a seller established in one EU country selling digital services:
 * - customer in the seller's country: domestic VAT, with or without a VAT id;
 * - EU business customer with a VAT id elsewhere: 0%, reverse charge (Art. 196);
 * - EU consumer elsewhere: the customer country's rate (One-Stop Shop);
 * - US: state sales tax where SaaS is taxable, otherwise nothing;
 * - anywhere else: outside the scope of EU VAT.
 * Tax is computed on the invoice's taxable total and rounded half up to the
 * cent, the usual commercial rounding tax authorities expect.
 */
export class StaticTaxProvider implements TaxProvider {
    async quote(request: TaxRequest): Promise<TaxQuote> {
        const { customer, seller, taxable } = request;
        const country = customer.country.toUpperCase();
        const base = taxable > 0n ? taxable : 0n;
        const at = (regime: TaxQuote["regime"], jurisdiction: string, rateBps: number, note: string): TaxQuote => ({
            regime,
            jurisdiction,
            rateBps,
            taxable: base,
            amount: amountFor(base, rateBps),
            note,
        });

        const euRate = EU_VAT_BPS[country];
        if (country === seller.country) return at("domestic", country, euRate ?? 0, `VAT ${formatRate(euRate ?? 0)}`);
        if (euRate !== undefined) {
            if (customer.vatId && isPlausibleVatId(country, customer.vatId)) {
                return at("reverse_charge", country, 0, `Reverse charge: VAT to be accounted for by the recipient (Art. 196 Directive 2006/112/EC). Customer VAT ID ${customer.vatId}`);
            }
            return at("oss_destination", country, euRate, `VAT ${formatRate(euRate)} (${country}), declared via OSS`);
        }
        if (country === "US") {
            const region = customer.region?.toUpperCase() ?? "";
            const rate = US_SALES_TAX_BPS[region];
            if (rate !== undefined) return at("us_sales_tax", `US-${region}`, rate, `Sales tax ${formatRate(rate)} (${region})`);
            return at("not_taxable", `US-${region || "?"}`, 0, "Not subject to sales tax in this state");
        }
        return at("not_taxable", country, 0, "Outside the scope of EU VAT");
    }
}

export function amountFor(taxable: Cents, rateBps: number): Cents {
    return divRound(taxable * BigInt(rateBps), 10_000n, "half-up");
}

function formatRate(bps: number): string {
    return `${formatFixed(BigInt(bps), 2)}%`;
}
