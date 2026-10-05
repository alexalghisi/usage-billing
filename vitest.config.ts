import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/**/*.test.ts", "web/src/**/*.test.ts"],
        globalSetup: ["test/global-setup.ts"],
        testTimeout: 30_000,
        hookTimeout: 120_000,
        // Integration tests share one mongod and one ElasticMQ; each file uses its own database and queues.
        fileParallelism: true,
        maxWorkers: 2,
    },
});
