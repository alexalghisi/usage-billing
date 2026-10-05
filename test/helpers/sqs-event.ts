import type { SQSEvent, SQSRecord } from "aws-lambda";

let counter = 0;

export function sqsRecord(body: unknown, messageId = `m-${++counter}`): SQSRecord {
    return {
        messageId,
        receiptHandle: `rh-${messageId}`,
        body: typeof body === "string" ? body : JSON.stringify(body),
        attributes: { ApproximateReceiveCount: "1", SentTimestamp: "0", SenderId: "test", ApproximateFirstReceiveTimestamp: "0" },
        messageAttributes: {},
        md5OfBody: "",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:eu-west-1:000000000000:usage",
        awsRegion: "eu-west-1",
    };
}

export function sqsEvent(...bodies: unknown[]): SQSEvent {
    return { Records: bodies.map((b) => sqsRecord(b)) };
}
