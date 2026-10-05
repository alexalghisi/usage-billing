import type { Cents } from "../money/money.ts";
import type { TaxProfile } from "../orgs/org.ts";

export type TaxRegime = "domestic" | "reverse_charge" | "oss_destination" | "us_sales_tax" | "not_taxable";

export interface TaxQuote {
    regime: TaxRegime;
    jurisdiction: string;
    rateBps: number;
    taxable: Cents;
    amount: Cents;
    /** Text that must appear on the invoice, e.g. the reverse-charge statement. */
    note: string;
}

export interface TaxRequest {
    seller: { country: string };
    customer: TaxProfile;
    taxable: Cents;
    supplyDate: Date;
}

/** Port for tax calculation; a tax engine (Avalara, Stripe Tax, ...) would sit behind it in production. */
export interface TaxProvider {
    quote(request: TaxRequest): Promise<TaxQuote>;
}
