/**
 * Pluggable WebFetch retrieval backends.
 *
 *   - PlaywrightBackend (default): launches headless Chromium, renders JS, and
 *     returns the full HTML for the caller to convert to markdown.
 *   - W3mBackend: dumps rendered text via the `w3m` CLI (no JS execution).
 *
 * Playwright is often installed globally rather than in the project's
 * node_modules, so we resolve the module from the `playwright` CLI location
 * when a plain import fails. Select a backend with PI_WEBFETCH_BACKEND
 * (`playwright` | `w3m`); default is `playwright`.
 */

import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveBin } from "./bin.ts";

export type PageContent = {
	// 'html' -> caller runs the HTML->markdown converter; 'text' -> already rendered.
	kind: "html" | "text";
	content: string;
	contentType: string;
	statusCode: number;
	statusText: string;
	finalUrl: string;
};

export interface FetchBackend {
	fetch(url: string, signal?: AbortSignal): Promise<PageContent>;
}

const PLAYWRIGHT_TIMEOUT_MS = 60_000;
const W3M_TIMEOUT_MS = 30_000;
/** Max wait for a page to settle (stop navigating) before re-capturing content. */
const NAV_SETTLE_MS = 3_000;
/** Retries for the "page is navigating" capture error. */
const NAV_RETRIES = 3;

// biome-ignore lint/suspicious/noExplicitAny: Playwright is resolved dynamically at runtime.
let chromiumPromise: Promise<any> | undefined;

/**
 * Resolve Playwright's `chromium` launcher, importing the (possibly global)
 * module. Lazy: the heavy dependency stays out of cold start until WebFetch is
 * actually used with the Playwright backend.
 */
// biome-ignore lint/suspicious/noExplicitAny: dynamic module shape.
function loadChromium(): Promise<any> {
	if (!chromiumPromise) {
		chromiumPromise = (async () => {
			// 1. Plain resolution (installed locally / on NODE_PATH). The specifier
			// is held in a variable so bundlers/type-checkers don't treat Playwright
			// as a required static dependency — it may only exist globally.
			try {
				const pkg = "playwright";
				// biome-ignore lint/suspicious/noExplicitAny: dynamic import shape.
				const mod: any = await import(pkg);
				const pw = mod?.chromium ? mod : mod?.default;
				if (pw?.chromium) return pw.chromium;
			} catch {
				// Fall through to global discovery.
			}

			// 2. Discover the CLI, resolve to its module directory, and require it.
			const bin = resolveBin("playwright");
			if (!bin) {
				throw new Error(
					"playwright not found. Install it (e.g. `npm i -g playwright && playwright install chromium`) or set PI_WEBFETCH_BACKEND=w3m.",
				);
			}
			const moduleDir = dirname(realpathSync(bin)); // .../node_modules/playwright
			const pkg = JSON.parse(readFileSync(join(moduleDir, "package.json"), "utf8")) as { main?: string };
			const entry = join(moduleDir, pkg.main ?? "index.js");
			const require = createRequire(pathToFileURL(join(moduleDir, "package.json")).href);
			const pw = require(entry);
			if (!pw?.chromium) throw new Error("Resolved playwright but its chromium export is missing.");
			return pw.chromium;
		})().catch((err) => {
			// Don't cache a failed resolution — a later attempt may succeed once
			// the CLI is installed or PATH changes.
			chromiumPromise = undefined;
			throw err;
		});
	}
	return chromiumPromise;
}

export class PlaywrightBackend implements FetchBackend {
	async fetch(url: string, signal?: AbortSignal): Promise<PageContent> {
		const chromium = await loadChromium();
		const browser = await chromium.launch({ headless: true });
		try {
			const page = await browser.newPage({ userAgent: "Mozilla/5.0 (compatible; pi-agent WebFetch)" });
			const onAbort = () => {
				browser.close().catch(() => {});
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: PLAYWRIGHT_TIMEOUT_MS });
			// Some sites (e.g. LinkedIn) keep client-side navigating after
			// domcontentloaded, so page.content() can throw "page is navigating and
			// changing the content". Wait for the navigation to settle and retry.
			const html: string = await withNavigationRetry(
				() => page.content(),
				() => waitNavigationSettled(page, NAV_SETTLE_MS),
				NAV_RETRIES,
			);
			const finalUrl = page.url();
			const statusCode = response?.status() ?? 200;
			const contentType = response?.headers()["content-type"] ?? "text/html";

			signal?.removeEventListener("abort", onAbort);
			return {
				kind: "html",
				content: html,
				contentType,
				statusCode,
				statusText: response?.statusText() ?? "",
				finalUrl,
			};
		} finally {
			await browser.close().catch(() => {});
		}
	}
}

export class W3mBackend implements FetchBackend {
	fetch(url: string, signal?: AbortSignal): Promise<PageContent> {
		return new Promise((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("aborted"));
				return;
			}
			const bin = resolveBin("w3m");
			if (!bin) {
				reject(new Error("w3m not found. Install with `brew install w3m` or `apt install w3m`."));
				return;
			}
			// -dump renders the page to stdout. w3m follows redirects internally and
			// does not surface an HTTP status, so we report 200.
			const child = spawn(bin, ["-dump", url], { signal });
			let stdout = "";
			let stderr = "";
			const timer = setTimeout(() => child.kill("SIGKILL"), W3M_TIMEOUT_MS);

			child.stdout.on("data", (c) => {
				stdout += c;
			});
			child.stderr.on("data", (c) => {
				stderr += c;
			});
			child.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				if (code !== 0) {
					reject(new Error(`w3m exited ${code}: ${stderr.trim()}`));
					return;
				}
				resolve({
					kind: "text",
					content: stdout,
					contentType: "text/plain",
					statusCode: 200,
					statusText: "",
					finalUrl: url,
				});
			});
		});
	}
}

/**
 * Run `fetchContent`, retrying on "page is navigating" errors. Each retry waits
 * for the navigation to settle first (via `settle`). Any other error is rethrown
 * immediately, as is the navigation error once retries are exhausted.
 */
export async function withNavigationRetry<T>(
	fetchContent: () => Promise<T>,
	settle: () => Promise<void>,
	retries: number,
): Promise<T> {
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fetchContent();
		} catch (e) {
			if (attempt === retries || !isNavigationError(e)) throw e;
			await settle();
		}
	}
	// Unreachable; keeps the type checker honest.
	throw new Error("withNavigationRetry: unexpected state");
}

/** Playwright's error when the page is still navigating during page.content(). */
function isNavigationError(e: unknown): boolean {
	return typeof e === "object" && e !== null && "message" in e && /navigating/i.test(String((e as Error).message));
}

/**
 * Wait for the page to stop navigating. Resolves early when a navigation
 * completes; falls back to a fixed delay so a page that navigates forever
 * cannot hang the fetch.
 */
function waitNavigationSettled(
	page: { waitForNavigation: (o?: unknown) => Promise<unknown> },
	timeoutMs: number,
): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => resolve(), timeoutMs);
		page
			.waitForNavigation({ waitUntil: "domcontentloaded" })
			.catch(() => {})
			.then(() => {
				clearTimeout(timer);
				resolve();
			});
	});
}

/** Select a backend from PI_WEBFETCH_BACKEND. Default: Playwright. */
export function getFetchBackend(): FetchBackend {
	const choice = (process.env.PI_WEBFETCH_BACKEND ?? "playwright").toLowerCase();
	return choice === "w3m" ? new W3mBackend() : new PlaywrightBackend();
}
