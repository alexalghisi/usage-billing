// Captures docs/preview.gif frames from the running demo (npm run dev + npm run dev:web)
// and from a recorded `npm run simulate` output; scripts/make-gif.py assembles them.
//   APP_URL=http://127.0.0.1:5310 SIM_OUTPUT=.local/sim-output.txt node scripts/capture-preview.ts
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright";

const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:5310";
const OUT = ".local/capture";
const frames: { file: string; ms: number; caption: string }[] = [];
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

async function snap(page: Page, caption: string, ms: number): Promise<void> {
    const file = `${OUT}/${String(frames.length).padStart(3, "0")}.png`;
    await page.screenshot({ path: file });
    frames.push({ file, ms, caption });
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// 1. Usage accumulating and the running estimate moving.
await page.goto(`${APP_URL}/#/org_acme`);
await page.waitForSelector("[data-testid=accrued]");
await page.waitForTimeout(2500);
for (let i = 0; i < 8; i++) {
    await snap(page, "Live usage flows SQS -> Lambda handler -> MongoDB -> hourly rollups; the running bill follows", 700);
    await page.waitForTimeout(1000);
}

// 2. Invoice with a late-usage adjustment, then the drill-down to rollups.
await page.click("table.invoices >> text=September 2026");
await page.waitForSelector("text=Draft invoice");
await page.waitForTimeout(800);
await page.evaluate("window.scrollTo(0, 560)");
await page.waitForTimeout(400);
await snap(page, "The September draft carries an adjustment for August usage that arrived after August was finalized", 2200);
await page.click("text=Adjustment for 2026-08");
await page.waitForSelector("text=Why this adjustment");
await page.waitForTimeout(500);
await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
await page.waitForTimeout(400);
await snap(page, "August is re-rated with the late usage; only the difference is billed", 2600);

await page.evaluate("window.scrollTo(0, 560)");
await page.click("table.invoices >> text=August 2026");
await page.waitForSelector("text=QC-2026-");
await page.waitForTimeout(600);
await snap(page, "A finalized invoice: numbered, hash-verified, immutable", 1800);
await page.click("tr.clickable >> text=Compute:");
await page.waitForSelector("text=Usage behind");
await page.waitForTimeout(600);
await page.evaluate("window.scrollTo(0, 860)");
await page.waitForTimeout(400);
await snap(page, "Drill-down: price bands and the hourly rollups behind the line", 2600);

// 3. A marketplace-billed org.
await page.goto(`${APP_URL}/#/org_hooli`);
await page.waitForSelector("text=Reported to AWS Marketplace");
await page.waitForTimeout(1500);
await page.evaluate("window.scrollTo(0, 400)");
await page.waitForTimeout(300);
await snap(page, "Marketplace-billed orgs: hourly BatchMeterUsage reports instead of a card invoice", 2200);

// 4. Terminal output of the month simulation.
const ansi = readFileSync(process.env.SIM_OUTPUT ?? ".local/sim-output.txt", "utf8");
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function toHtml(text: string): string {
    let open = 0;
    const html = escape(text).replace(/\x1b\[(\d+)m/g, (_m, code: string) => {
        if (code === "0") {
            const close = "</span>".repeat(open);
            open = 0;
            return close;
        }
        open++;
        return `<span class="c${code}">`;
    });
    return html + "</span>".repeat(open);
}
const lines = ansi.trimEnd().split("\n");
const term = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const css = `body{margin:0;background:#141413;color:#e8e6dc;font:12.5px/1.45 ui-monospace,"DejaVu Sans Mono",Menlo,monospace}
.bar{background:#262624;color:#a3a29a;padding:8px 16px;font-size:12px}
pre{margin:0;padding:14px 18px;white-space:pre}
.prompt{color:#7cb7ff}.c1{font-weight:700;color:#fff}.c2{color:#8d8c84}.c32{color:#5cc98a}.c31{color:#ef7d7d}`;
const steps = [lines.findIndex((l) => l.includes("invoice run 2026-10")) + 1, lines.findIndex((l) => l.includes("audit")) + 1, lines.length];
for (const [i, n] of steps.entries()) {
    const shown = lines.slice(0, n).join("\n");
    await term.setContent(`<style>${css}</style><div class="bar">usage-billing</div><pre><span class="prompt">$</span> npm run simulate -- --orgs 24\n${toHtml(shown)}</pre>`);
    const file = `${OUT}/${String(frames.length).padStart(3, "0")}.png`;
    await term.screenshot({ path: file });
    frames.push({ file, ms: i === steps.length - 1 ? 5000 : 1600, caption: "End-to-end month simulation, checked against an independent decimal.js calculation" });
}

writeFileSync(`${OUT}/frames.json`, JSON.stringify(frames, null, 2));
await browser.close();
process.stdout.write(`${frames.length} frames in ${OUT}\n`);
