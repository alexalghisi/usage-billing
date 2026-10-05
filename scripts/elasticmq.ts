// Runs a local ElasticMQ (SQS-compatible) server until interrupted.
//   npm run sqs              -> http://127.0.0.1:9335
//   SQS_PORT=9400 npm run sqs
import { startElasticMq } from "../src/infra/elasticmq.ts";

const port = Number(process.env.SQS_PORT ?? 9335);
const server = await startElasticMq({ port, workDir: ".local" });
process.stdout.write(`ElasticMQ listening on ${server.endpoint}\n`);
const shutdown = () => void server.stop().then(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
