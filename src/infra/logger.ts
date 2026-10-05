export interface Logger {
    info(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
}

function line(level: string, msg: string, fields?: Record<string, unknown>): string {
    return JSON.stringify({ level, msg, ...fields }, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

export const jsonLogger: Logger = {
    info: (msg, fields) => process.stdout.write(`${line("info", msg, fields)}\n`),
    warn: (msg, fields) => process.stderr.write(`${line("warn", msg, fields)}\n`),
    error: (msg, fields) => process.stderr.write(`${line("error", msg, fields)}\n`),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };
