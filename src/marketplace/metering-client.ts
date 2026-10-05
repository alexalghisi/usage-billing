import { BatchMeterUsageCommand, MarketplaceMeteringClient } from "@aws-sdk/client-marketplace-metering";

export interface MeterRecord {
    customerIdentifier: string;
    dimension: string;
    /** Whole dimension units; AWS only accepts integers. */
    quantity: number;
    timestamp: Date;
}

export interface MeterResult {
    record: MeterRecord;
    status: "Success" | "DuplicateRecord" | "CustomerNotSubscribed";
    meteringRecordId?: string;
}

export interface MeteringClient {
    batchMeterUsage(productCode: string, records: readonly MeterRecord[]): Promise<{ results: MeterResult[]; unprocessed: MeterRecord[] }>;
}

/** The real AWS SDK client; pointed at the fake endpoint locally and at AWS in production. */
export class AwsMeteringClient implements MeteringClient {
    private readonly client: MarketplaceMeteringClient;

    constructor(options: { endpoint?: string; region?: string; maxAttempts?: number }) {
        this.client = new MarketplaceMeteringClient({
            region: options.region ?? "us-east-1",
            // Retries are left to the reporter, which needs to see every failed attempt to know whether AWS may have recorded it.
            maxAttempts: options.maxAttempts ?? 1,
            ...(options.endpoint ? { endpoint: options.endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
        });
    }

    async batchMeterUsage(productCode: string, records: readonly MeterRecord[]) {
        const res = await this.client.send(
            new BatchMeterUsageCommand({
                ProductCode: productCode,
                UsageRecords: records.map((r) => ({ CustomerIdentifier: r.customerIdentifier, Dimension: r.dimension, Quantity: r.quantity, Timestamp: r.timestamp })),
            }),
        );
        const toRecord = (u: { CustomerIdentifier?: string; Dimension?: string; Quantity?: number; Timestamp?: Date }): MeterRecord => ({
            customerIdentifier: u.CustomerIdentifier ?? "",
            dimension: u.Dimension ?? "",
            quantity: u.Quantity ?? 0,
            timestamp: u.Timestamp ?? new Date(0),
        });
        return {
            results: (res.Results ?? []).map((r) => ({
                record: toRecord(r.UsageRecord ?? {}),
                status: (r.Status ?? "Success") as MeterResult["status"],
                ...(r.MeteringRecordId ? { meteringRecordId: r.MeteringRecordId } : {}),
            })),
            unprocessed: (res.UnprocessedRecords ?? []).map(toRecord),
        };
    }

    destroy(): void {
        this.client.destroy();
    }
}
