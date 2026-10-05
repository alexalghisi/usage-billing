import { definePlan, PlanCatalog } from "./plan.ts";

// List prices of the fictional "Quarry Cloud" managed database service.
// compute: compute-unit-minutes, storage: GB-hours, transfer: GB of egress.
export const developer = definePlan({
    id: "developer",
    name: "Developer",
    baseFee: "0.00",
    meters: {
        compute: { model: "tiered", tiers: [["6000", "0"], [null, "0.0042"]] },
        storage: { model: "tiered", tiers: [["7200", "0"], [null, "0.000041"]] },
        transfer: { model: "tiered", tiers: [["10", "0"], [null, "0.09"]] },
    },
});

export const scale = definePlan({
    id: "scale",
    name: "Scale",
    baseFee: "99.00",
    meters: {
        compute: { model: "tiered", tiers: [["100000", "0.0036"], ["1000000", "0.0031"], [null, "0.0026"]] },
        storage: { model: "volume", tiers: [["72000", "0.000040"], ["720000", "0.000034"], [null, "0.000029"]] },
        transfer: { model: "tiered", tiers: [["1000", "0.085"], ["10000", "0.07"], [null, "0.05"]] },
    },
});

export const enterprise = definePlan({
    id: "enterprise",
    name: "Enterprise",
    baseFee: "1500.00",
    meters: {
        compute: { model: "volume", tiers: [["1000000", "0.0030"], ["5000000", "0.0025"], [null, "0.0021"]] },
        storage: { model: "volume", tiers: [["720000", "0.000032"], [null, "0.000027"]] },
        transfer: { model: "tiered", tiers: [["10000", "0.06"], [null, "0.04"]] },
    },
});

export const defaultCatalog = new PlanCatalog([developer, scale, enterprise]);
