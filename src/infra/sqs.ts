import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

export function createSqsClient(endpoint: string): SQSClient {
    return new SQSClient({
        endpoint,
        region: "eu-west-1",
        // ElasticMQ ignores credentials, but the SDK insists on having some.
        credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
}

export interface QueuePair {
    queueUrl: string;
    queueArn: string;
    dlqUrl: string;
}

/** Creates the queue and its dead-letter queue; messages move to the DLQ after `maxReceiveCount` failed receives. */
export async function ensureQueue(sqs: SQSClient, name: string, maxReceiveCount = 5, visibilityTimeoutSeconds = 30): Promise<QueuePair> {
    const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `${name}-dlq` }));
    if (!dlq.QueueUrl) throw new Error("CreateQueue returned no URL");
    const dlqAttrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ["QueueArn"] }));
    const dlqArn = dlqAttrs.Attributes?.QueueArn;
    if (!dlqArn) throw new Error("DLQ has no ARN");
    const main = await sqs.send(
        new CreateQueueCommand({
            QueueName: name,
            Attributes: {
                VisibilityTimeout: String(visibilityTimeoutSeconds),
                RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount }),
            },
        }),
    );
    if (!main.QueueUrl) throw new Error("CreateQueue returned no URL");
    const attrs = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: main.QueueUrl, AttributeNames: ["QueueArn"] }));
    return { queueUrl: main.QueueUrl, queueArn: attrs.Attributes?.QueueArn ?? `arn:aws:sqs:eu-west-1:000000000000:${name}`, dlqUrl: dlq.QueueUrl };
}

/** Visible plus in-flight messages. */
export async function queueDepth(sqs: SQSClient, queueUrl: string): Promise<number> {
    const res = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible", "ApproximateNumberOfMessagesDelayed"] }),
    );
    const a = res.Attributes ?? {};
    return Number(a.ApproximateNumberOfMessages ?? 0) + Number(a.ApproximateNumberOfMessagesNotVisible ?? 0) + Number(a.ApproximateNumberOfMessagesDelayed ?? 0);
}
