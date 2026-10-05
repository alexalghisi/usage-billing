import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ElasticMQ is an SQS-compatible server on the JVM. It is used instead of real SQS
// for local runs and tests; the code only talks to it through the AWS SDK.
export const ELASTICMQ_VERSION = "1.6.14";
const DEFAULT_JAR = resolve(import.meta.dirname, "../../.local", `elasticmq-server-${ELASTICMQ_VERSION}.jar`);
const DOWNLOAD_URL = `https://s3-eu-west-1.amazonaws.com/softwaremill-public/elasticmq-server-${ELASTICMQ_VERSION}.jar`;

export interface ElasticMq {
    endpoint: string;
    stop(): Promise<void>;
}

export function ensureElasticMqJar(jarPath = DEFAULT_JAR): string {
    if (existsSync(jarPath)) return jarPath;
    mkdirSync(dirname(jarPath), { recursive: true });
    // curl honours the proxy and CA settings of the environment, which Node's fetch does not.
    const result = spawnSync("curl", ["-fsSL", "-o", jarPath, DOWNLOAD_URL], { stdio: "inherit" });
    if (result.status !== 0) throw new Error(`could not download ElasticMQ from ${DOWNLOAD_URL}`);
    return jarPath;
}

export async function isSqsReachable(endpoint: string): Promise<boolean> {
    try {
        const res = await fetch(`${endpoint}/?Action=ListQueues`, { signal: AbortSignal.timeout(1000) });
        return res.ok;
    } catch {
        return false;
    }
}

export async function startElasticMq(options: { port: number; jarPath?: string; workDir: string }): Promise<ElasticMq> {
    const jar = ensureElasticMqJar(options.jarPath);
    const endpoint = `http://127.0.0.1:${options.port}`;
    mkdirSync(options.workDir, { recursive: true });
    const config = join(options.workDir, `elasticmq-${options.port}.conf`);
    writeFileSync(
        config,
        [
            'include classpath("application.conf")',
            `node-address { protocol = http, host = "127.0.0.1", port = ${options.port}, context-path = "" }`,
            `rest-sqs { enabled = true, bind-port = ${options.port}, bind-hostname = "127.0.0.1", sqs-limits = strict }`,
            "rest-stats { enabled = false }",
            "",
        ].join("\n"),
    );
    const child: ChildProcess = spawn("java", ["-Xmx384m", `-Dconfig.file=${config}`, "-Dlogback.configurationFile=none", "-jar", jar], {
        stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-4000)));
    const deadline = Date.now() + 60_000;
    while (!(await isSqsReachable(endpoint))) {
        if (child.exitCode !== null) throw new Error(`ElasticMQ exited with ${child.exitCode}: ${stderr}`);
        if (Date.now() > deadline) {
            child.kill();
            throw new Error("ElasticMQ did not start within 60s");
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    return {
        endpoint,
        stop: () =>
            new Promise<void>((done) => {
                if (child.exitCode !== null) return done();
                child.once("exit", () => done());
                child.kill("SIGTERM");
            }),
    };
}
