// All billing time is UTC. Periods are half-open intervals [start, end).
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function startOfHour(d: Date): Date {
    return new Date(Math.floor(d.getTime() / HOUR_MS) * HOUR_MS);
}

export function startOfDay(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function startOfMonth(d: Date): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

export function addMonths(d: Date, months: number): Date {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(), d.getUTCHours()));
}

export function addHours(d: Date, hours: number): Date {
    return new Date(d.getTime() + hours * HOUR_MS);
}

export interface Period {
    start: Date;
    end: Date;
}

/** "2026-09" -> [2026-09-01, 2026-10-01) */
export function monthPeriod(key: string): Period {
    const match = /^(\d{4})-(\d{2})$/.exec(key);
    if (!match) throw new Error(`invalid period key: ${key}`);
    const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    if (Number.isNaN(start.getTime()) || start.getUTCMonth() !== Number(match[2]) - 1) throw new Error(`invalid period key: ${key}`);
    return { start, end: addMonths(start, 1) };
}

export function periodKey(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousPeriodKey(key: string): string {
    return periodKey(addMonths(monthPeriod(key).start, -1));
}

export interface Clock {
    now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FixedClock implements Clock {
    private current: Date;
    constructor(start: Date) {
        this.current = start;
    }
    now(): Date {
        return new Date(this.current);
    }
    set(d: Date): void {
        this.current = d;
    }
    advance(ms: number): void {
        this.current = new Date(this.current.getTime() + ms);
    }
}

/** Simulated time running `speed` times faster than the wall clock, used by the demo. */
export class AcceleratedClock implements Clock {
    private readonly startedAt = Date.now();
    private readonly origin: Date;
    private readonly speed: number;
    constructor(origin: Date, speed: number) {
        this.origin = origin;
        this.speed = speed;
    }
    now(): Date {
        return new Date(this.origin.getTime() + (Date.now() - this.startedAt) * this.speed);
    }
}
