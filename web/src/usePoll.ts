import { useEffect, useState } from "react";

/** Loads on mount and whenever deps change, then refreshes every intervalMs. Stale responses are dropped via abort. */
export function usePoll<T>(load: (signal: AbortSignal) => Promise<T>, intervalMs: number, deps: unknown[]): { data: T | undefined; error: string | undefined } {
    const [data, setData] = useState<T>();
    const [error, setError] = useState<string>();
    useEffect(() => {
        let controller = new AbortController();
        let stopped = false;
        setData(undefined);
        const tick = async () => {
            controller.abort();
            controller = new AbortController();
            try {
                const value = await load(controller.signal);
                if (!stopped) {
                    setData(value);
                    setError(undefined);
                }
            } catch (e) {
                if (!stopped && !(e instanceof DOMException && e.name === "AbortError")) setError(String(e));
            }
        };
        void tick();
        const timer = intervalMs > 0 ? setInterval(() => void tick(), intervalMs) : undefined;
        return () => {
            stopped = true;
            controller.abort();
            if (timer) clearInterval(timer);
        };
    }, deps);
    return { data, error };
}
